/**
 * The request handler itself: serves a deployment's files from S3.
 * For each GET/HEAD: subdomain → deployment id → status check (deployed? building?
 * failed?) → URL path → candidate S3 keys → stream the first one that exists,
 * forwarding Content-Type, Cache-Control and ETag (with 304 support).
 */
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler, Response } from "express";
import { deploymentFilesPrefix } from "@repo/shared";
import { deploymentIdFromHost, getDeploymentStatus } from "./deployment";
import { badRequestPage, failedPage, fileNotFoundPage, inProgressPage, notFoundPage } from "./pages";
import { resolvePath } from "./resolve";
import { getFile, headFile, type FileMeta } from "./s3";

function sendHtml(res: Response, status: number, html: string) {
  res.status(status).type("html").set("Cache-Control", "no-store").send(html);
}

function setFileHeaders(res: Response, meta: FileMeta) {
  if (meta.contentType) res.type(meta.contentType);
  if (meta.contentLength !== undefined) res.set("Content-Length", String(meta.contentLength));
  if (meta.cacheControl) res.set("Cache-Control", meta.cacheControl);
  if (meta.etag) res.set("ETag", meta.etag);
  if (meta.lastModified) res.set("Last-Modified", meta.lastModified.toUTCString());
}

async function serveHead(res: Response, keys: string[]) {
  for (const key of keys) {
    const meta = await headFile(key);
    if (meta) {
      setFileHeaders(res, meta);
      res.status(200).end();
      return true;
    }
  }
  return false;
}

async function serveGet(req: Request, res: Response, keys: string[]) {
  const ifNoneMatch = req.get("If-None-Match");

  for (const key of keys) {
    const result = await getFile(key, ifNoneMatch);
    if (result.kind === "not-found") continue;

    if (result.kind === "not-modified") {
      setFileHeaders(res, result.meta);
      res.status(304).end();
      return true;
    }

    setFileHeaders(res, result.meta);
    res.status(200);
    // pipeline() destroys the S3 stream if the browser disconnects mid-download
    await pipeline(result.body, res);
    return true;
  }
  return false;
}

export const serveDeployment: RequestHandler = async (req, res, next) => {
  const id = deploymentIdFromHost(req.hostname);
  if (!id) return next(); // not a deployment host → fall through to the app's own routes

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.set("Allow", "GET, HEAD").status(405).end();
    return;
  }

  const status = await getDeploymentStatus(id);
  if (status === null) return sendHtml(res, 404, notFoundPage());
  if (status === "failed") return sendHtml(res, 404, failedPage());
  if (status !== "deployed") return sendHtml(res, 503, inProgressPage(status));

  const resolution = resolvePath(req.path);
  if (!resolution) return sendHtml(res, 400, badRequestPage());

  const prefix = deploymentFilesPrefix(id);
  const keys = resolution.keys.map((k) => prefix + k);
  if (resolution.spaFallback) keys.push(prefix + "index.html");

  const served = req.method === "HEAD" ? await serveHead(res, keys) : await serveGet(req, res, keys);
  if (!served) sendHtml(res, 404, fileNotFoundPage());
};
