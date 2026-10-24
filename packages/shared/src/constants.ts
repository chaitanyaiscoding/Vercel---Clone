export const MAX_REPO_SIZE = 100 * 1024; // in KB (GitHub reports repo size in KB) → 100 MB

export const deploymentKey = (id: string) => `deployment:${id}`;

// Redis Stream that carries deploy jobs from upload-service to deploy-service
export const DEPLOY_STREAM = "deploy:stream";
// Consumer group the deploy workers join; Redis hands each entry to one member
export const DEPLOY_CONSUMER_GROUP = "deploy-workers";
// Keep roughly this many entries; older (already processed) ones are trimmed
export const DEPLOY_STREAM_MAXLEN = 10_000;
