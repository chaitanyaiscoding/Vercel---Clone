/**
 * Loads and validates the request-handler's environment variables with zod at boot.
 * Exits with a readable error if config is missing or malformed. AWS credentials are
 * not validated here: .env locally, a read-only IAM role in production.
 */
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  REDIS_URL: z.url(),
  AWS_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  // Deployments are served at <id>.<BASE_DOMAIN>. "localhost" works in dev because
  // browsers (and curl) resolve *.localhost to 127.0.0.1.
  BASE_DOMAIN: z
    .string()
    .min(1)
    .default("localhost")
    .transform((d) => d.toLowerCase()),
  // Behind a load balancer / CDN, trust X-Forwarded-* headers for the real host & IP
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("[request-handler] invalid environment variables:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
