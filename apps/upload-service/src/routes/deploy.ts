/**
 * HTTP routes for deployments.
 * POST /deploy            → validate repo, pin commit SHA, record + enqueue, respond 202 { id }.
 * GET  /status/:id        → the deployment record plus its public site URL.
 * GET  /status/:id/logs   → build log lines, read incrementally with ?from=.
 */
import { Router } from "express";
import { customAlphabet } from "nanoid";
import {
  DEPLOYMENT_ID_ALPHABET,
  DEPLOYMENT_ID_LENGTH,
  DEPLOYMENT_ID_REGEX,
  deployRequestSchema,
  deploymentKey,
  deploymentLogsKey,
  MAX_REPO_SIZE,
  type Deployment,
  type DeploymentLogs,
  type DeploymentResponse,
} from "@repo/shared";
import { env } from "../env";
import { HttpError } from "../errors";
import { getLatestSha, getRepoInfo, parseRepoUrl } from "../github";
import { enqueueDeployment } from "../queue";
import { redis } from "../redis";

const generateId = customAlphabet(DEPLOYMENT_ID_ALPHABET, DEPLOYMENT_ID_LENGTH);

export const deployRouter = Router();

deployRouter.post("/deploy", async (req, res) => {
  const body = deployRequestSchema.safeParse(req.body);
  if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "Invalid request body");

  const { owner, repo } = parseRepoUrl(body.data.repoUrl);

  const info = await getRepoInfo(owner, repo);
  if (info.private) throw new HttpError(404, "Repository not found or is private");
  if (info.size > MAX_REPO_SIZE) {
    throw new HttpError(413, `Repository is too large (max ${MAX_REPO_SIZE / 1024} MB)`);
  }

  const sha = await getLatestSha(owner, repo, info.default_branch);

  const deployment: Deployment = {
    id: generateId(),
    // normalized: no trailing slash / .git, so the worker always gets one shape
    repoUrl: `https://github.com/${owner}/${repo}`,
    sha,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  await enqueueDeployment(deployment);

  res.status(202).json({ id: deployment.id, status: deployment.status });
});

function parseId(raw: string) {
  if (!DEPLOYMENT_ID_REGEX.test(raw)) throw new HttpError(400, "Invalid deployment id");
  return raw;
}

deployRouter.get("/status/:id", async (req, res) => {
  const id = parseId(req.params.id);

  // Redis returns {} for a missing key, not null
  const record = await redis.hgetall(deploymentKey(id));
  if (Object.keys(record).length === 0) throw new HttpError(404, "Deployment not found");

  const body: DeploymentResponse = {
    ...(record as unknown as Deployment),
    url: env.SITE_URL_TEMPLATE.replace("{id}", id),
  };
  res.json(body);
});

// Incremental log reads: the client sends ?from=<the `next` it got last time>.
// The list only keeps the newest lines, so we translate the absolute line number
// `from` into a list index using the record's total `logCount`.
deployRouter.get("/status/:id/logs", async (req, res) => {
  const id = parseId(req.params.id);
  const from = Number(req.query.from ?? 0);
  if (!Number.isInteger(from) || from < 0) throw new HttpError(400, "`from` must be a non-negative integer");

  const [[, total], [, listLength]] = (await redis
    .multi()
    .hget(deploymentKey(id), "logCount")
    .llen(deploymentLogsKey(id))
    .exec()) as [[null, string | null], [null, number]];

  // No logCount (deployments from before it existed): the list is the whole log
  const totalLines = total === null ? listLength : Number(total);
  const firstInList = totalLines - listLength; // absolute number of the oldest line still stored
  const start = Math.max(from - firstInList, 0);

  const lines = start < listLength ? await redis.lrange(deploymentLogsKey(id), start, -1) : [];
  const body: DeploymentLogs = { lines, next: firstInList + start + lines.length };
  res.json(body);
});
