/**
 * Publishes deploy jobs to the Redis stream.
 * enqueueDeployment() saves the deployment record and XADDs the job in a single
 * MULTI/EXEC transaction, so a record never exists without its job (or vice versa).
 */
import { DEPLOY_STREAM, DEPLOY_STREAM_MAXLEN, deploymentKey, toStreamFields, type Deployment } from "@repo/shared";
import { redis } from "./redis";

// Save the deployment record and publish its job in one MULTI/EXEC transaction.
// Redis runs both commands back-to-back with nothing in between, and if the
// connection drops before EXEC neither runs — so we never end up with a record
// that has no job, or a job whose record doesn't exist yet.
export async function enqueueDeployment(deployment: Deployment) {
  const job = { id: deployment.id, repoUrl: deployment.repoUrl, sha: deployment.sha };

  const results = await redis
    .multi()
    .hset(deploymentKey(deployment.id), { ...deployment })
    // MAXLEN ~ : trim old entries approximately (cheap). "*" : Redis generates the entry id.
    .xadd(DEPLOY_STREAM, "MAXLEN", "~", DEPLOY_STREAM_MAXLEN, "*", ...toStreamFields(job))
    .exec();

  // exec() gives one [error, result] pair per command, or null if the transaction was aborted
  const failure = results ? results.find(([err]) => err)?.[0] : new Error("transaction aborted");
  if (failure) throw failure;
}
