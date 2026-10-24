/**
 * Uploads a finished build's static output to S3 under `dist/<id>/`.
 * Treats the output as untrusted: skips symlinks, enforces file-count and size
 * limits, and sets Content-Type + Cache-Control per file so browsers execute JS
 * and cache hashed assets forever while always re-checking index.html.
 */
import fs from "node:fs";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import mime from "mime-types";
import { env } from "./env";
import { BuildError } from "./errors";

const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB
const UPLOAD_CONCURRENCY = 8;

// Credentials come from the default chain: env vars locally, IAM role in production
const s3 = new S3Client({ region: env.AWS_REGION });

interface OutputFile {
  absPath: string;
  key: string; // S3 key, always "/"-separated
  size: number;
}

async function collectFiles(dir: string, prefix: string): Promise<OutputFile[]> {
  const entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  const files: OutputFile[] = [];
  let total = 0;

  for (const entry of entries) {
    // isFile() is false for symlinks: a build could otherwise ship
    // `index.html -> /etc/passwd` and make US upload a file from the host.
    if (!entry.isFile()) continue;

    const absPath = path.join(entry.parentPath, entry.name);
    const { size } = await fs.promises.stat(absPath);
    total += size;
    if (files.length >= MAX_FILES) throw new BuildError(`Build output has more than ${MAX_FILES} files`);
    if (total > MAX_TOTAL_BYTES) throw new BuildError(`Build output is larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);

    // path.relative uses "\" on Windows; S3 keys must use "/"
    const rel = path.relative(dir, absPath).split(path.sep).join("/");
    files.push({ absPath, key: prefix + rel, size });
  }

  if (!files.some((f) => f.key === prefix + "index.html")) {
    throw new BuildError("Build output has no index.html");
  }
  return files;
}

function cacheControlFor(key: string) {
  if (key.endsWith(".html")) return "no-cache"; // always revalidate so new deploys show up
  if (key.includes("/assets/")) return "public, max-age=31536000, immutable"; // hashed filenames
  return "public, max-age=3600";
}

// Runs fn over items with at most `limit` in flight at once.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

// Returns the number of files uploaded.
export async function uploadDir(dir: string, prefix: string): Promise<number> {
  const files = await collectFiles(dir, prefix);

  await mapLimit(files, UPLOAD_CONCURRENCY, async (file) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: file.key,
        Body: fs.createReadStream(file.absPath),
        ContentLength: file.size,
        ContentType: mime.lookup(file.absPath) || "application/octet-stream",
        CacheControl: cacheControlFor(file.key),
      }),
    );
  });

  return files.length;
}
