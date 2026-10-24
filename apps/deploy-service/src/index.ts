/**
 * deploy-service entry point.
 * Boot: validate env → check Redis → check Docker + builder image → remove leftover
 * build containers → ensure the consumer group → start BUILD_CONCURRENCY worker loops.
 * Shutdown (SIGINT/SIGTERM): stop taking jobs, kill running builds (their jobs stay
 * unacked and are retried by another worker), wait for loops, close Redis.
 */
import { env } from "./env";
import { abortAllBuilds, assertDockerReady, removeLeftoverContainers } from "./docker";
import { assertRedisReachable, redis } from "./redis";
import { ensureGroup } from "./stream";
import { runWorker } from "./worker";

await assertRedisReachable();
await assertDockerReady();
await removeLeftoverContainers();
await ensureGroup();

let stopping = false;
const loops = Array.from({ length: env.BUILD_CONCURRENCY }, (_, i) => runWorker(i, () => stopping));

console.log(
  `[deploy-service] ${env.CONSUMER_NAME} running ${env.BUILD_CONCURRENCY} worker(s), image=${env.BUILDER_IMAGE}`,
);

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[deploy-service] ${signal} received, shutting down`);

  // Hosts like ECS send SIGTERM then SIGKILL ~30 s later — too soon to wait for a
  // 10-minute build. Kill builds now; their unacked jobs get picked up elsewhere.
  await abortAllBuilds();
  await Promise.allSettled(loops);
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
