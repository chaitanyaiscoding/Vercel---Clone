export type DeploymentStatus = "queued" | "building" | "uploading" | "deployed" | "failed";

export interface DeployJob {
  id: string;       // lowercase, subdomain-safe (we'll use nanoid custom alphabet)
  repoUrl: string;  // https://github.com/owner/repo
  sha: string;      // exact commit to build
}
