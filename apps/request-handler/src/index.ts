/**
 * request-handler entry point.
 * Checks Redis, builds the Express app (security headers, deployment serving on
 * <id>.<BASE_DOMAIN>, /health on the bare domain, error handler), starts listening,
 * and shuts down cleanly on SIGINT/SIGTERM.
 */
import express, { type ErrorRequestHandler } from "express";
import { env } from "./env";
import { errorPage } from "./pages";
import { assertRedisReachable, redis } from "./redis";
import { serveDeployment } from "./serve";

await assertRedisReachable();

const app = express();
app.disable("x-powered-by"); // don't advertise "X-Powered-By: Express" to attackers
app.set("trust proxy", env.TRUST_PROXY);

app.use((_req, res, next) => {
  // Browsers must trust our Content-Type instead of guessing ("sniffing") it
  res.set("X-Content-Type-Options", "nosniff");
  next();
});

app.use(serveDeployment);

// Only reached on hosts that aren't <id>.<BASE_DOMAIN>, e.g. plain localhost:3001
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  // The response may already be streaming a file; then all we can do is cut it off
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(502).type("html").set("Cache-Control", "no-store").send(errorPage());
};
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  console.log(`[request-handler] serving http://<id>.${env.BASE_DOMAIN}:${env.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`[request-handler] ${signal} received, shutting down`);
  server.close();
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
