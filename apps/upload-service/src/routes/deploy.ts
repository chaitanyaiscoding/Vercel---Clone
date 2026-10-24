/**
 * HTTP routes for deployments.
 * POST /deploy       → validate repo, pin commit SHA, record + enqueue, respond 202 { id }.
 * GET  /status/:id   → return the deployment record from Redis.
 */
import { Router } from "express";
import { customAlphabet } from "nanoid";
import { deployRequestSchema, deploymentKey, MAX_REPO_SIZE, type Deployment } from "@repo/shared";
import { HttpError } from "../errors";
import { getLatestSha, getRepoInfo, parseRepoUrl } from "../github";
import { enqueueDeployment } from "../queue";
import { redis } from "../redis";

// Lowercase only: the id becomes a subdomain, and DNS is case-insensitive
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 10;
const generateId = customAlphabet(ID_ALPHABET, ID_LENGTH);
const ID_REGEX = new RegExp(`^[0-9a-z]{${ID_LENGTH}}$`);

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

deployRouter.get("/status/:id", async (req, res) => {
  const { id } = req.params;
  if (!ID_REGEX.test(id)) throw new HttpError(400, "Invalid deployment id");

  // Redis returns {} for a missing key, not null
  const record = await redis.hgetall(deploymentKey(id));
  if (Object.keys(record).length === 0) throw new HttpError(404, "Deployment not found");

  res.json(record as unknown as Deployment);
});
