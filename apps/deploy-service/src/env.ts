/**
 * Loads and validates the deploy-service's environment variables with zod at boot.
 * Exits with a readable error if config is missing or malformed, and exports a
 * typed `env` object. AWS credentials are deliberately NOT validated here: locally
 * they come from .env, in production from an IAM role — the AWS SDK finds either.
 */
import os from "node:os";
import { z } from "zod";

const envSchema = z.object({
  REDIS_URL: z.url(),
  AWS_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),

  // Docker image that runs untrusted builds (see builder/Dockerfile)
  BUILDER_IMAGE: z.string().default("vercel-clone-builder"),
  BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),
  // Builds this process runs in parallel. Each one gets its own container.
  BUILD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  // Per-container limits, passed straight to `docker create`
  BUILD_MEMORY: z.string().regex(/^\d+[mg]$/).default("1g"),
  BUILD_CPUS: z.string().regex(/^\d+(\.\d+)?$/).default("1"),

  // Name of this worker inside the Redis consumer group; must be unique per process
  CONSUMER_NAME: z.string().default(`${os.hostname()}-${process.pid}`),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("[deploy-service] invalid environment variables:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
