import { z } from "zod";
import type { DeployJob } from "./types";

// Stream entries are flat lists of strings: ["id", "abc", "repoUrl", "https://…", …].
// Both sides convert through these helpers so the format lives in one place.

const deployJobSchema = z.object({
  id: z.string(),
  repoUrl: z.string(),
  sha: z.string(),
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
