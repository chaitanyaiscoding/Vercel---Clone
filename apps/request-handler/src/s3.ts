/**
 * Read-only S3 access for serving deployed files.
 * getFile() fetches an object as a stream (or reports not-found / not-modified);
 * headFile() fetches only its metadata, for HEAD requests.
 * Note: if the IAM role lacks s3:ListBucket, S3 answers 403 instead of 404 for
 * missing keys — the production read-only policy must include ListBucket.
 */
import type { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { env } from "./env";

// Credentials come from the default chain: env vars locally, IAM role in production
const s3 = new S3Client({ region: env.AWS_REGION });

export interface FileMeta {
  contentType?: string;
  contentLength?: number;
  cacheControl?: string;
  etag?: string;
  lastModified?: Date;
}

export type GetResult =
  | { kind: "found"; meta: FileMeta; body: Readable }
  | { kind: "not-modified"; meta: FileMeta }
  | { kind: "not-found" };

function statusOf(err: unknown) {
  return err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
}

// ifNoneMatch: the browser's cached ETag. If unchanged S3 replies 304 and we
// forward that, so the browser reuses its copy instead of downloading again.
export async function getFile(key: string, ifNoneMatch?: string): Promise<GetResult> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, IfNoneMatch: ifNoneMatch }));
    return {
      kind: "found",
      meta: {
        contentType: res.ContentType,
        contentLength: res.ContentLength,
        cacheControl: res.CacheControl,
        etag: res.ETag,
        lastModified: res.LastModified,
      },
      body: res.Body as Readable, // in Node the SDK returns a Readable stream
    };
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) return { kind: "not-found" };
    if (status === 304) return { kind: "not-modified", meta: { etag: ifNoneMatch } };
    throw err;
  }
}

export async function headFile(key: string): Promise<FileMeta | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return {
      contentType: res.ContentType,
      contentLength: res.ContentLength,
      cacheControl: res.CacheControl,
      etag: res.ETag,
      lastModified: res.LastModified,
    };
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}
