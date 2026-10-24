import cors from "cors";
import express from "express";
import { env } from "./env";
import { errorHandler } from "./errors";
import { assertRedisReachable, redis } from "./redis";
import { deployRouter } from "./routes/deploy";

await assertRedisReachable();

const app = express();
app.disable("x-powered-by"); // don't advertise "X-Powered-By: Express" to attackers
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json({ limit: "10kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.use(deployRouter);
app.use(errorHandler); // must be registered last

const server = app.listen(env.PORT, () => {
  console.log(`[upload-service] listening on http://localhost:${env.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`[upload-service] ${signal} received, shutting down`);
  server.close();
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
