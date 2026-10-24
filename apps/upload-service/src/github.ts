/**
 * GitHub REST API client.
 * Parses github.com URLs into owner/repo, fetches repo metadata (public? size? default branch)
 * and resolves the branch to an exact commit SHA. Maps GitHub failures to HttpErrors.
 */
import { z } from "zod";
import { GITHUB_URL_REGEX } from "@repo/shared";
import { env } from "./env";
import { HttpError } from "./errors";

const GITHUB_API = "https://api.github.com";

const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "vercel-clone", // GitHub rejects requests without one
  "X-GitHub-Api-Version": "2022-11-28",
  ...(env.GITHUB_TOKEN && { Authorization: `Bearer ${env.GITHUB_TOKEN}` }),
};

// Only the fields we use. Parsing means a surprise response shape fails loudly here.
const repoSchema = z.object({
  private: z.boolean(),
  size: z.number(), // KB
  default_branch: z.string(),
});

const commitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
});

export type RepoInfo = z.infer<typeof repoSchema>;

export function parseRepoUrl(url: string) {
  const match = GITHUB_URL_REGEX.exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) throw new HttpError(400, "Must be https://github.com/<owner>/<repo>");
  return { owner, repo };
}

async function githubGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(502, "Could not reach GitHub");
  }

  // GitHub returns 404 for private repos too, so we can't (and shouldn't) tell them apart
  if (res.status === 404) throw new HttpError(404, "Repository not found or is private");
  if (res.status === 409) throw new HttpError(422, "Repository is empty");
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    throw new HttpError(503, "GitHub rate limit reached, try again later");
  }
  if (!res.ok) throw new HttpError(502, `GitHub API error (${res.status})`);

  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new HttpError(502, "Unexpected response froKm GitHub");
  return parsed.data;
}

export function getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
  return githubGet(`/repos/${owner}/${repo}`, repoSchema);
}

// Resolve a branch name to the exact commit it points at right now
export async function getLatestSha(owner: string, repo: string, branch: string): Promise<string> {
  const commit = await githubGet(`/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, commitSchema);
  console.log(` -------- upload-service] resolved ${owner}/${repo}@${branch} → ${commit.sha} ------------------`);
  return commit.sha;
}
