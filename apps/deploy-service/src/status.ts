/**
 * Reads and writes a deployment's user-visible state in Redis.
 * - setStatus / getStatus: the `deployment:<id>` hash that GET /status/:id returns.
 * - createLogSink: buffers build log lines and appends them to the capped list
 *   `deployment:<id>:logs` once a second, instead of one Redis call per line,
 *   and keeps the total line count in the `logCount` field of the record.
 */
import { deploymentKey, deploymentLogsKey, type DeploymentStatus } from "@repo/shared";
import { redis } from "./redis";

const MAX_LOG_LINES = 1000;
const MAX_LINE_LENGTH = 2000;
const LOG_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOG_FLUSH_MS = 1000;

export async function getStatus(id: string): Promise<DeploymentStatus | null> {
  return (await redis.hget(deploymentKey(id), "status")) as DeploymentStatus | null;
}

export async function setStatus(id: string, status: DeploymentStatus, error?: string) {
  await redis.hset(deploymentKey(id), {
    status,
    updatedAt: new Date().toISOString(),
    ...(error && { error }),
  });
  console.log(`[deploy ${id}] status → ${status}${error ? ` (${error})` : ""}`);
}

export function createLogSink(id: string) {
  const key = deploymentLogsKey(id);
  let buffer: string[] = [];

  async function flush() {
    if (buffer.length === 0) return;
    const lines = buffer;
    buffer = [];
    await redis
      .multi()
      .rpush(key, ...lines)
      .ltrim(key, -MAX_LOG_LINES, -1) // keep only the newest lines
      .expire(key, LOG_TTL_SECONDS)
      // Total lines ever written. Trimming shifts list positions, so readers page
      // through logs by this absolute count instead (see GET /status/:id/logs).
      .hincrby(deploymentKey(id), "logCount", lines.length)
      .exec();
  }

  const timer = setInterval(() => {
    flush().catch((err) => console.error(`[deploy ${id}] log flush failed:`, err));
  }, LOG_FLUSH_MS);

  return {
    push(line: string) {
      buffer.push(line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "…" : line);
    },
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
