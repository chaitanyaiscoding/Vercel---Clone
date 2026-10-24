/**
 * Thin wrappers around the Redis Stream commands the worker uses.
 * This file is the "queue library" we wrote instead of BullMQ:
 *   ensureGroup   → XGROUP CREATE (once)
 *   readNext      → XREADGROUP  (new entries, blocking)
 *   claimStale    → XAUTOCLAIM  (entries a dead worker was holding)
 *   heartbeat     → XCLAIM JUSTID (keep ownership of an entry during a long build)
 *   deliveryCount → XPENDING    (how many times an entry was handed out)
 *   ack           → XACK        (done, remove from the pending list)
 */
import type { Redis } from "ioredis";
import { DEPLOY_CONSUMER_GROUP, DEPLOY_STREAM } from "@repo/shared";
import { env } from "./env";
import { redis } from "./redis";

export interface StreamEntry {
  entryId: string; // Redis-generated, e.g. "1792832712213-0"
  fields: string[]; // flat ["id", "abc", "repoUrl", "…", …] — decode with fromStreamFields
}

// How long an entry must sit unacked, with no heartbeat, before another worker
// may take it. Heartbeats run well inside this window while a build is alive.
export const CLAIM_IDLE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
const BLOCK_MS = 5_000;

export async function ensureGroup() {
  try {
    // "0": also deliver entries added before the group existed. MKSTREAM: create the stream if missing.
    await redis.xgroup("CREATE", DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, "0", "MKSTREAM");
    console.log(`[stream] created consumer group ${DEPLOY_CONSUMER_GROUP}`);
  } catch (err) {
    if (!(err as Error).message.startsWith("BUSYGROUP")) throw err; // BUSYGROUP = already exists, fine
  }
}

// Waits up to BLOCK_MS for an entry no one in the group has received yet.
export async function readNext(client: Redis): Promise<StreamEntry | null> {
  const res = await client.xreadgroup(
    "GROUP", DEPLOY_CONSUMER_GROUP, env.CONSUMER_NAME,
    "COUNT", 1,
    "BLOCK", BLOCK_MS,
    "STREAMS", DEPLOY_STREAM, ">",
  );
  // null on timeout, else [[streamName, [[entryId, fields]]]]
  const entry = res?.[0]?.[1][0];
  if (!entry) return null;
  return { entryId: entry[0], fields: entry[1] ?? [] };
}

// Takes over one entry that has been pending longer than CLAIM_IDLE_MS
// (its worker crashed or was killed). Bumps the entry's delivery count.
export async function claimStale(): Promise<StreamEntry | null> {
  const res = (await redis.xautoclaim(
    DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, env.CONSUMER_NAME,
    CLAIM_IDLE_MS, "0-0", "COUNT", 1,
  )) as [cursor: string, entries: [string, string[] | null][], deleted: string[]];
  const entry = res[1][0];
  if (!entry) return null;
  return { entryId: entry[0], fields: entry[1] ?? [] };
}

// Re-claiming an entry we already own resets its idle time, so claimStale() on
// other workers leaves it alone. JUSTID: don't count this as another delivery.
export async function heartbeat(entryId: string) {
  await redis.xclaim(DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, env.CONSUMER_NAME, 0, entryId, "JUSTID");
}

export async function deliveryCount(entryId: string): Promise<number> {
  // → [[entryId, consumer, idleMs, deliveries]]
  const res = (await redis.xpending(DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, entryId, entryId, 1)) as [
    string, string, number, number,
  ][];
  return res[0]?.[3] ?? 0;
}

export async function ack(entryId: string) {
  await redis.xack(DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, entryId);
}
