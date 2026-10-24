# Builder image: the throwaway sandbox that runs ONE untrusted user build.
# Contains Node + curl/tar, runs as the unprivileged `node` user, and its only
# job is build.sh. It never receives AWS keys or any other secret.
# Build it with: pnpm --filter deploy-service builder:build
FROM node:24-alpine

RUN apk add --no-cache curl tar

# CI=true makes many tools non-interactive; corepack must not prompt before
# fetching pnpm/yarn; NO_COLOR keeps ANSI escape codes out of the stored build logs.
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NO_COLOR=1

USER node
WORKDIR /home/node/app
RUN mkdir -p /home/node/output

COPY --chmod=755 build.sh /usr/local/bin/build.sh
ENTRYPOINT ["/usr/local/bin/build.sh"]
