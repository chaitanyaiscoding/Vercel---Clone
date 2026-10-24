/**
 * Shared TypeScript types for a deployment.
 * - DeployJob: the message published to the deploy stream (what a worker needs to build).
 * - Deployment: the record stored at `deployment:<id>` in Redis (what the user sees via /status).
 */
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
  updatedAt?: string; // ISO timestamp of the last status change
  error?: string; // only set when status is "failed"
}