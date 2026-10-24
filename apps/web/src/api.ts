/**
 * Typed client for the upload-service HTTP API.
 * createDeployment → POST /deploy, getDeployment → GET /status/:id,
 * getLogs → GET /status/:id/logs?from=. Errors become ApiError with a message
 * that is safe to show in the UI.
 */
import type { DeploymentLogs, DeploymentResponse, DeploymentStatus } from "@repo/shared";

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3002").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    public status: number, // 0 = network error (API unreachable)
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, init);
  } catch {
    throw new ApiError(0, "Can't reach the API. Is the upload-service running?");
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function createDeployment(repoUrl: string) {
  return request<{ id: string; status: DeploymentStatus }>("/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });
}

export function getDeployment(id: string) {
  return request<DeploymentResponse>(`/status/${id}`);
}

export function getLogs(id: string, from: number) {
  return request<DeploymentLogs>(`/status/${id}/logs?from=${from}`);
}
