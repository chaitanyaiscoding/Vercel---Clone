/**
 * Figures out WHICH deployment a request is for, and whether it can be served.
 * - deploymentIdFromHost: "abc123xyz0.localhost" → "abc123xyz0" (or null).
 * - getDeploymentStatus: reads `deployment:<id>` status from Redis, with a small
 *   in-memory cache so every asset request doesn't hit Redis.
 */
import { DEPLOYMENT_ID_REGEX, deploymentKey, type DeploymentStatus } from "@repo/shared";
import { env } from "./env";
import { redis } from "./redis";

// A deployed site doesn't change, so cache that for a while. Anything else
// (building, uploading…) is cached briefly so the "building" page updates quickly.
const DEPLOYED_TTL_MS = 60_000;
const PENDING_TTL_MS = 2_000;
const MAX_CACHE_ENTRIES = 10_000;

const cache = new Map<string, { status: DeploymentStatus | null; expiresAt: number }>();

export function deploymentIdFromHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  const suffix = `.${env.BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;

  const sub = host.slice(0, -suffix.length);
  // Exactly one label of the right shape: rejects "a.b.localhost", "localhost", etc.
  return DEPLOYMENT_ID_REGEX.test(sub) ? sub : null;
}

export async function getDeploymentStatus(id: string): Promise<DeploymentStatus | null> {
  const hit = cache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.status;

  const status = (await redis.hget(deploymentKey(id), "status")) as DeploymentStatus | null;

  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear(); // crude, but bounds memory
  cache.set(id, { status, expiresAt: Date.now() + (status === "deployed" ? DEPLOYED_TTL_MS : PENDING_TTL_MS) });
  return status;
}
