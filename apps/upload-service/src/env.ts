/**
 * Loads and validates environment variables with zod at boot.
 * Exits the process with a readable error if config is missing or malformed,
 * and exports a typed `env` object for the rest of the service.
 */
import { z } from "zod";

// Validate config once at boot so a bad .env crashes immediately with a clear
// message, instead of surfacing later as a mystery `undefined`.
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3002),
  REDIS_URL: z.url(),
  // `GITHUB_TOKEN=` in .env gives "", treat that the same as unset
  GITHUB_TOKEN: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("[upload-service] invalid environment variables:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
