/**
 * One worker loop: repeatedly take a job from the stream and run the pipeline.
 * Order each iteration: reclaim a crashed worker's job first, else wait for a new one.
 * Owns the ack decision: XACK after the pipeline returns; leave the entry pending
 * when it throws (infra failure) so it is retried; give up after MAX_DELIVERIES.
 * index.ts starts BUILD_CONCURRENCY of these loops in parallel.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fromStreamFields, type DeployJob } from "@repo/shared";
import { processJob } from "./pipeline";
import { createBlockingClient } from "./redis";
import { setStatus } from "./status";
import { ack, claimStale, deliveryCount, heartbeat, HEARTBEAT_MS, readNext, type StreamEntry } from "./stream";

const MAX_DELIVERIES = 3;

async function handleEntry({ entryId, fields }: StreamEntry) {
  let job: DeployJob;
  try {
    job = fromStreamFields(fields);
  } catch {
    // Malformed entry: it can never succeed, so drop it instead of retrying forever
    console.error(`[worker] dropping malformed stream entry ${entryId}`, fields);
    await ack(entryId);
    return;
  }

  const deliveries = await deliveryCount(entryId);
  if (deliveries > MAX_DELIVERIES) {
    await setStatus(job.id, "failed", `Gave up after ${MAX_DELIVERIES} attempts (internal error)`);
    await ack(entryId);
    return;
  }

  // Keep ownership while the build runs, so other workers don't reclaim it
  const beat = setInterval(() => {
    heartbeat(entryId).catch((err) => console.error(`[worker] heartbeat failed for ${entryId}:`, err));
  }, HEARTBEAT_MS);

  try {
    await processJob(job);
    await ack(entryId);
  } catch (err) {
    console.error(`[deploy ${job.id}] attempt ${deliveries}/${MAX_DELIVERIES} hit an internal error, will retry:`, err);
    // Best effort: show the user it's waiting again rather than stuck on "building"
    await setStatus(job.id, "queued").catch(() => {});
  } finally {
    clearInterval(beat);
  }
}

export async function runWorker(slot: number, isStopping: () => boolean) {
  const blocking = createBlockingClient();
  console.log(`[worker ${slot}] started`);

  while (!isStopping()) {
    try {
      const entry = (await claimStale()) ?? (await readNext(blocking));
      if (entry && !isStopping()) await handleEntry(entry);
    } catch (err) {
      // e.g. Redis restarting: back off instead of spinning
      console.error(`[worker ${slot}] loop error:`, err);
      await sleep(5_000);
    }
  }

  blocking.disconnect();
  console.log(`[worker ${slot}] stopped`);
}
