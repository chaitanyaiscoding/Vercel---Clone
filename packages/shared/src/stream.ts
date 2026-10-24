/**
 * Encode/decode helpers for deploy-stream entries.
 * Redis Streams store each entry as a flat list of strings; these helpers turn a
 * DeployJob into that list (producer) and validate it back into a DeployJob (consumer).
 */
import { z } from "zod";
import { DEPLOYMENT_ID_REGEX } from "./constants";
import { GITHUB_URL_REGEX } from "./schema";
import type { DeployJob } from "./types";

// Stream entries are flat lists of strings: ["id", "abc", "repoUrl", "https://…", …].
// Both sides convert through these helpers so the format lives in one place.

// Strict on purpose: the worker turns these values into a download URL and a
// container name, so anything unexpected is rejected before it gets that far.
const deployJobSchema = z.object({
  id: z.string().regex(DEPLOYMENT_ID_REGEX),
  repoUrl: z.string().regex(GITHUB_URL_REGEX),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
});

export function toStreamFields(job: DeployJob): string[] {
  return Object.entries(job).flat();
}

export function fromStreamFields(fields: string[]): DeployJob {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    obj[fields[i]!] = fields[i + 1]!;
  }
  return deployJobSchema.parse(obj);
}
