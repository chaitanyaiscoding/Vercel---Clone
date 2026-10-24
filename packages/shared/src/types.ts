export type DeploymentStatus = "queued" | "building" | "uploading" | "deployed" | "failed";

export interface DeployJob {
  id: string;       // lowercase, subdomain-safe (we'll use nanoid custom alphabet)
  repoUrl: string;  // https://github.com/owner/repo
  sha: string;      // exact commit to build
}

export interface Deployment {
  id: string;
  repoUrl: string;
  sha: string;
  status: DeploymentStatus;
  createdAt: string; // ISO timestamp
  error?: string; // only set when status is "failed"
}