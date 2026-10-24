/**
 * Error types that decide what the worker does with a failed job.
 * - BuildError: the USER's project is at fault (build failed, no output, too big,
 *   timed out). The deployment is marked failed and the job is acked — retrying
 *   the same broken commit would just fail again.
 * - Any other error is treated as OUR infrastructure failing (Docker down, S3
 *   error, Redis blip): the job is not acked, so it is retried later.
 */
export class BuildError extends Error {}
