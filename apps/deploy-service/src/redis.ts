/**
 * Redis connections for the deploy-service.
 * - `redis`: shared client for status updates, logs, XACK/XPENDING/XAUTOCLAIM.
 * - createBlockingClient(): one extra connection per worker loop, used only for
 *   `XREADGROUP ... BLOCK`, which holds its connection while it waits.
 * Also exports assertRedisReachable(), a fail-fast check run at boot.
 */
import { Redis } from "ioredis";
import { env } from "./env";

// maxRetriesPerRequest: null → a worker never gives up on Redis; commands wait
// for the reconnect instead of throwing. (The HTTP API does the opposite.)
// lazyConnect: don't dial out at import time, before assertRedisReachable() has run.
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

redis.on("error", (err: NodeJS.ErrnoException) => console.error("[redis]", err.message || err.code));

export function createBlockingClient() {
  const client = redis.duplicate(); // same URL + options
  client.on("error", (err: NodeJS.ErrnoException) => console.error("[redis:blocking]", err.message || err.code));
  return client;
}

// Probe with a throwaway client that never retries, so boot fails in
// milliseconds when Redis is unreachable instead of waiting forever.
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
    console.error(`[deploy-service] cannot reach Redis at ${env.REDIS_URL} (${reason})`);
    console.error("Is it running? Try: docker compose up -d");
    process.exit(1);
  } finally {
    probe.disconnect();
  }
}
