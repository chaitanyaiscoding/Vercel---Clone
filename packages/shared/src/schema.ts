import { z } from "zod";

export const GITHUB_URL_REGEX =
  /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export const deployRequestSchema = z.object({
  repoUrl: z.string().trim().regex(GITHUB_URL_REGEX, "Must be https://github.com/<owner>/<repo>"),
});

export type DeployRequest = z.infer<typeof deployRequestSchema>;
