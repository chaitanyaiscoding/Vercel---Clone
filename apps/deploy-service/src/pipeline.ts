/**
 * The deploy pipeline for ONE job: building → uploading → deployed | failed.
 * Creates a temp folder, runs the sandboxed build (docker.ts), uploads the output
 * (s3.ts), records status + logs (status.ts), and always cleans up.
 * Returns normally when the job is finished for good (success OR user failure),
 * so the caller can XACK. Throws on infrastructure errors so the caller does not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deploymentFilesPrefix, type DeployJob } from "@repo/shared";
import { runBuild } from "./docker";
import { BuildError } from "./errors";
import { uploadDir } from "./s3";
import { createLogSink, getStatus, setStatus } from "./status";

export async function processJob(job: DeployJob) {
  const current = await getStatus(job.id);

  // Idempotency: a job can be delivered twice (crash + reclaim). Don't redo finished work.
  if (current === null) {
    console.warn(`[deploy ${job.id}] no deployment record, skipping`);
    return;
  }
  if (current === "deployed" || current === "failed") {
    console.log(`[deploy ${job.id}] already ${current}, skipping`);
    return;
  }

  await setStatus(job.id, "building");
  const logs = createLogSink(job.id);
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `vercel-build-${job.id}-`));

  try {
    logs.push(`→ building ${job.repoUrl} @ ${job.sha.slice(0, 7)}`);
    await runBuild(job, workDir, (line) => {
      console.log(`[build ${job.id}] ${line}`);
      logs.push(line);
    });

    await setStatus(job.id, "uploading");
    logs.push("→ uploading output");
    const count = await uploadDir(workDir, deploymentFilesPrefix(job.id));
    logs.push(`✓ uploaded ${count} files`);

    await setStatus(job.id, "deployed");
  } catch (err) {
    if (!(err instanceof BuildError)) throw err; // infrastructure → let the caller retry

    logs.push(`✗ ${err.message}`);
    await setStatus(job.id, "failed", err.message);
  } finally {
    await logs.close();
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
