/**
 * Shared constants: deployment id rules, Redis key names, the S3 folder layout,
 * stream/consumer-group names and limits. Lives here so the upload-service,
 * deploy-service and request-handler can never disagree on a name.
 */
export const MAX_REPO_SIZE = 100 * 1024; // in KB (GitHub reports repo size in KB) → 100 MB

// Deployment ids are lowercase alphanumerics: they become subdomains (DNS is case-insensitive)
export const DEPLOYMENT_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export const DEPLOYMENT_ID_LENGTH = 10;
export const DEPLOYMENT_ID_REGEX = new RegExp(`^[0-9a-z]{${DEPLOYMENT_ID_LENGTH}}$`);

// S3 folder holding a deployment's built files (written by deploy-service, served by request-handler)
export const deploymentFilesPrefix = (id: string) => `dist/${id}/`;

export const deploymentKey = (id: string) => `deployment:${id}`;
// Capped list of build log lines for a deployment (written by deploy-service)
export const deploymentLogsKey = (id: string) => `deployment:${id}:logs`;

// Redis Stream that carries deploy jobs from upload-service to deploy-service
export const DEPLOY_STREAM = "deploy:stream";
// Consumer group the deploy workers join; Redis hands each entry to one member
export const DEPLOY_CONSUMER_GROUP = "deploy-workers";
// Keep roughly this many entries; older (already processed) ones are trimmed
export const DEPLOY_STREAM_MAXLEN = 10_000;
