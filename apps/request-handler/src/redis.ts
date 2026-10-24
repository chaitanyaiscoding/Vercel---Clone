/**
 * Redis connection for the request-handler (read-only use: deployment status lookups).
 * Default retry settings so a page request fails fast if Redis is down, plus
 * assertRedisReachable(), a fail-fast connectivity check run at boot.
 */
import { Redis } from "ioredis";
import { env } from "./env";

// lazyConnect: don't dial out at import time, before assertRedisReachable() has run.
export const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

redis.on("error", (err: NodeJS.ErrnoException) => console.error("[redis]", err.message || err.code));

// Probe with a throwaway client that never retries, so boot fails in
// milliseconds when Redis is unreachable instead of retrying forever.
export async function assertRedisReachable() {
  const probe = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  // connect() only rejects with "Connection is closed"; the real cause arrives here
  let cause: NodeJS.ErrnoException | undefined;
  probe.on("error", (err) => (cause = err));

  try {
    await probe.connect();
    await probe.ping();
  } catch (err) {
    const reason = cause?.code ?? (err as Error).message;
    console.error(`[request-handler] cannot reach Redis at ${env.REDIS_URL} (${reason})`);
    console.error("Is it running? Try: docker compose up -d");
    process.exit(1);
  } finally {
    probe.disconnect();
  }
}
