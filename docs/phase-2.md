# Phase 2 — deploy-service (worker + build sandbox)

**Goal:** A worker reads jobs from the Redis stream, builds each repo inside a locked-down throwaway Docker container, uploads the static output to `s3://vercel-clone-chaitanya/dist/<id>/`, and updates the deployment status (`building → uploading → deployed | failed`).

```
Redis stream ──XREADGROUP──► deploy-service (TRUSTED: has AWS keys + Redis)
deploy:stream                  │
                               │ 1. status = building
                               │ 2. docker create + start  (no secrets, CPU/mem/pids limits, timeout)
                               ▼
                     builder container (UNTRUSTED)
                       curl tarball@sha → install → npm run build → copy dist/ to /home/node/output
                               │
                               │ 3. docker cp /home/node/output → local temp dir
                               │ 4. docker rm -f
                               ▼
                     deploy-service: status = uploading → PutObject each file → status = deployed → XACK
```

> ✅ The builder image + `docker create/start/cp` flow below was tested end-to-end on this machine (Docker Desktop on Windows) before writing this doc.

> ✅ **Implemented & tested (2026-10-24).** Differences from the original plan below, made with production in mind:
> - **Heartbeats** (`XCLAIM ... JUSTID` every 15 s) keep ownership of a running build, so the reclaim threshold is **60 s** instead of "longer than the build timeout". Crashed jobs recover in ~1 min; long builds are never stolen.
> - **SIGTERM aborts builds** and leaves their jobs unacked (retried elsewhere) instead of waiting up to 10 min — ECS/Kubernetes SIGKILL after ~30 s.
> - **Boot cleanup** removes `build-*` containers labelled `vercel-clone.build` (assumes one deploy-service process per Docker host).
> - Extra files vs §2.3: `errors.ts` (BuildError = user failure) and `pipeline.ts` (one job end-to-end); `worker.ts` is the loop.
> - Build logs are stored in `deployment:<id>:logs` (last 1000 lines, 7-day TTL).
> - AWS keys are optional in env: `.env` locally, IAM role in production.

**Rule for this project:** every file starts with a doc comment saying what it does (`/** ... */` in TS, `#` in shell/Dockerfile).

---

## 2.0 Concepts before code

### Trusted vs untrusted
| | deploy-service (Node, on host) | builder container |
|---|---|---|
| Runs | our code | **the user's** `postinstall` scripts + build script |
| Has AWS keys | ✅ | ❌ **never** |
| Has Redis access | ✅ | ❌ |
| Network | full | internet (needs GitHub + npm registry) |
| Lifetime | long-running | one build, then deleted |

The container's only output channel is the files in `/home/node/output`, which **we** copy out and **we** upload. The untrusted code never touches a credential.

### Why `docker create` → `start` → `cp` instead of a bind mount (`-v`)?
- A bind mount lets untrusted code write directly into a host folder (symlink tricks, huge files, etc).
- On Windows, bind-mounted `node_modules` is extremely slow.
- `docker cp` pulls out only the output folder, after the container has stopped.

### Two kinds of failure — handle them differently
| Failure | Example | What to do |
|---|---|---|
| **User build failure** | repo has a TS error, no `package.json`, no `index.html` output, build timeout | status = `failed` with a reason, **XACK** (retrying broken code is pointless) |
| **Infrastructure failure** | Docker not running, S3 down, Redis blip | **don't XACK** → entry stays pending → reclaimed and retried, up to `MAX_DELIVERIES` |

---

## 2.1 One-time setup

### Line endings (important on Windows!)
A `build.sh` with Windows CRLF line endings fails inside Linux with `/bin/sh^M: not found`. Create `.gitattributes` at the repo root:

```gitattributes
* text=auto
*.sh text eol=lf
Dockerfile text eol=lf
```

### Node version for builds
Node 20 reached end-of-life in April 2026. Use **`node:24-alpine`** for the builder (matches your local Node 24):

```powershell
docker pull node:24-alpine
docker rmi node:20-alpine   # optional cleanup
```

### Dependencies

```powershell
pnpm --filter deploy-service add ioredis zod @aws-sdk/client-s3 mime-types
pnpm --filter deploy-service add -D @types/mime-types
```

> pnpm may ask you to approve build scripts again — check what it lists before approving. After installing, open each package's `package.json` in `node_modules` and confirm the API you're about to use exists in that version (you've been getting very new majors).

### `apps/deploy-service/.env`

```env
REDIS_URL=redis://localhost:6379
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=vercel-clone-chaitanya
BUILDER_IMAGE=vercel-clone-builder
BUILD_TIMEOUT_MS=600000
```

The AWS SDK reads `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment automatically — you don't pass them to the client yourself.

---

## 2.2 The builder image — `apps/deploy-service/builder/`

### `builder/Dockerfile`

```dockerfile
# Builder image: the throwaway sandbox that runs ONE untrusted user build.
# Contains Node + curl/tar, runs as the unprivileged `node` user, and its only
# job is build.sh. It never receives AWS keys or any other secret.
FROM node:24-alpine

RUN apk add --no-cache curl tar

# CI=true makes many tools non-interactive; corepack must not prompt before fetching pnpm/yarn
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0

USER node
WORKDIR /home/node/app
RUN mkdir -p /home/node/output

COPY --chmod=755 build.sh /usr/local/bin/build.sh
ENTRYPOINT ["/usr/local/bin/build.sh"]
```

### `builder/build.sh`

```sh
#!/bin/sh
# Runs INSIDE the untrusted builder container.
# Downloads the repo at an exact commit, installs deps with the repo's own package
# manager, runs its build, and copies the static output to /home/node/output,
# which the deploy-service copies out with `docker cp` after the container exits.
# Exit codes: 10 = no package.json, 11 = no static output found, other = install/build failed.
set -eu

: "${TARBALL_URL:?TARBALL_URL is required}"

echo "→ downloading source"
# --max-filesize: refuse tarballs over 200 MB
curl -fsSL --max-filesize 209715200 "$TARBALL_URL" | tar -xz --strip-components=1

[ -f package.json ] || { echo "✗ no package.json at repo root"; exit 10; }

echo "→ installing dependencies"
if   [ -f pnpm-lock.yaml ];    then corepack pnpm install --frozen-lockfile
elif [ -f yarn.lock ];         then corepack yarn install
elif [ -f package-lock.json ]; then npm ci
else                                npm install
fi

echo "→ building"
npm run build

for d in dist build out; do
  if [ -f "$d/index.html" ]; then
    cp -r "$d"/. /home/node/output/
    echo "✓ output from ./$d"
    exit 0
  fi
done

echo "✗ no dist/, build/ or out/ containing index.html"
exit 11
```

🤔 **Think about:** why `--strip-components=1`? (GitHub tarballs wrap everything in a folder like `repo-<sha>/`.)

### Build and try it by hand

```powershell
docker build -t vercel-clone-builder apps/deploy-service/builder

# get a SHA for the test repo (or copy one from GET /status/<id>)
$sha = (Invoke-RestMethod https://api.github.com/repos/RoyRao2333/template-vite-react-ts-tailwind/commits/main).sha

docker create --name build-test `
  --memory 1g --memory-swap 1g --cpus 1 --pids-limit 512 `
  --cap-drop ALL --security-opt no-new-privileges `
  -e TARBALL_URL="https://codeload.github.com/RoyRao2333/template-vite-react-ts-tailwind/tar.gz/$sha" `
  vercel-clone-builder

docker start -a build-test        # streams logs, returns when the build ends (~2-3 min)
docker inspect -f "{{.State.ExitCode}}" build-test
docker cp build-test:/home/node/output/. .\tmp-out
docker rm -f build-test
```

You should see `index.html`, `assets/*.js`, `assets/*.css` in `tmp-out` (delete it afterwards).

### What each `docker create` flag does

| Flag | Protects against |
|---|---|
| `--memory 1g --memory-swap 1g` | a build eating all host RAM (swap = memory means no extra swap) |
| `--cpus 1` | one build starving the host / other builds |
| `--pids-limit 512` | fork bombs |
| `--cap-drop ALL` | removes Linux capabilities (raw sockets, chown, etc.) |
| `--security-opt no-new-privileges` | setuid binaries escalating to root |
| `USER node` (Dockerfile) | code runs as uid 1000, not root |
| *no* `-v`, *no* `--privileged`, *no* docker socket | container can't touch the host filesystem or Docker itself |

⚠️ **Never** write `-e AWS_ACCESS_KEY_ID` (without `=value`). Docker then copies the value **from your host environment** into the container. Only pass `TARBALL_URL`.

---

## 2.3 File layout

```
apps/deploy-service/
  builder/
    Dockerfile
    build.sh
  src/
    index.ts      → boot: env check, ensure consumer group, start loop, graceful shutdown
    env.ts        → zod-validated env (REDIS_URL, S3_BUCKET, BUILDER_IMAGE, BUILD_TIMEOUT_MS, ...)
    redis.ts      → TWO ioredis connections (see below)
    stream.ts     → ensureGroup, readNext, claimStale, deliveryCount, ack
    status.ts     → setStatus(id, status, error?) on deployment:<id>
    docker.ts     → runBuild(job, outDir): create → start (with timeout) → cp → rm
    s3.ts         → uploadDir(localDir, prefix) with content types + cache headers
    worker.ts     → processJob(entryId, job): the whole pipeline + failure classification
```

---

## 2.4 Implementation notes (write these yourself)

### `redis.ts` — why two connections?
`XREADGROUP ... BLOCK 5000` **holds its connection** for up to 5 s while it waits. Any other command on that same connection (like `HSET status`) waits behind it. So:

- `streamClient` → only for blocking reads. `new Redis(url, { maxRetriesPerRequest: null })` — a worker should never give up reconnecting.
- `redis` → everything else (status updates, XACK, XPENDING).

### `stream.ts`
ioredis has a method per command; arguments are the same tokens you'd type in `redis-cli`.

```ts
// create the group once; "0" = also deliver entries added before the group existed
await redis.xgroup("CREATE", DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, "0", "MKSTREAM");
// throws "BUSYGROUP Consumer Group name already exists" on every later boot → catch & ignore that one

// wait up to 5 s for one new entry. Returns null on timeout, or:
// [[streamName, [[entryId, ["id","abc","repoUrl","…","sha","…"]]]]]
await streamClient.xreadgroup("GROUP", DEPLOY_CONSUMER_GROUP, CONSUMER, "COUNT", 1, "BLOCK", 5000, "STREAMS", DEPLOY_STREAM, ">");

// take over entries another (dead) consumer held for longer than minIdleMs
// returns [nextCursor, [[entryId, fields], ...], deletedIds]
await redis.xautoclaim(DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, CONSUMER, minIdleMs, "0-0", "COUNT", 1);

// how many times has this entry been delivered? → [[entryId, consumer, idleMs, deliveries]]
await redis.xpending(DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, entryId, entryId, 1);

await redis.xack(DEPLOY_STREAM, DEPLOY_CONSUMER_GROUP, entryId);
```

- Decode `fields` with `fromStreamFields()` from `@repo/shared`. If it throws (malformed entry), XACK it and log — it will never succeed.
- `CONSUMER` name: `` `${os.hostname()}-${process.pid}` `` is fine.

🤔 **Critical:** the claim threshold must be **longer than the build timeout** (e.g. timeout 10 min → claim after 15 min). Otherwise a second worker steals a build that's still running.

### Main loop (`index.ts` / `worker.ts`)

```
ensureGroup()
while (!shuttingDown):
    entry = claimStale() ?? readNext()          # recover crashed jobs first
    if no entry: continue
    if deliveryCount(entry) > MAX_DELIVERIES (3):
        setStatus(failed, "gave up after 3 attempts"); xack; continue
    processJob(entry)
```

`processJob`:
1. If the record's status is already `deployed` → XACK and return (**idempotency**: a reclaimed job may already be done).
2. `setStatus("building")`
3. `runBuild()` into a fresh temp dir: `fs.mkdtemp(path.join(os.tmpdir(), "build-"))`
4. Non-zero exit / timeout → **user failure**: map exit code to a message (10 → "No package.json at repo root", 11 → "Build produced no dist/, build/ or out/ with index.html", else "Build failed (exit N)"), `setStatus("failed", msg)`, XACK.
5. `setStatus("uploading")` → `uploadDir(outDir, \`dist/${id}/\`)`
6. `setStatus("deployed")` → XACK
7. `finally`: delete the temp dir, `docker rm -f` the container (even on crash paths)
8. Any **other** thrown error (Docker down, S3 error) → log it, **don't XACK** → it'll be retried via claim.

### `docker.ts`
Use `child_process.spawn("docker", [...args])` — never build a shell string (`exec("docker run " + userInput)` = command injection).

- Container name: `build-${job.id}`. Before `create`, run `docker rm -f build-<id>` and ignore errors (a crashed earlier attempt may have left one).
- `TARBALL_URL`: `https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>` — derive owner/repo from `job.repoUrl` with `GITHUB_URL_REGEX`.
- `docker start -a` → pipe its stdout/stderr to your console prefixed with `[build <id>]`.
- Timeout: `setTimeout(() => spawn("docker", ["kill", name]), BUILD_TIMEOUT_MS)`; clear it when the process exits.
- Exit code: after `start -a` returns, `docker inspect -f "{{.State.ExitCode}}" <name>` (more reliable than the CLI's own exit code).
- Small helper worth writing: `docker(args): Promise<{ code, stdout, stderr }>`.

### `s3.ts`
- Walk `outDir` recursively (`fs.readdir(dir, { recursive: true, withFileTypes: true })`).
- **S3 key on Windows:** `path.relative(outDir, file).split(path.sep).join("/")` — S3 keys must use `/`.
- `PutObjectCommand({ Bucket, Key: \`dist/${id}/${rel}\`, Body: fs.createReadStream(file), ContentType })`
  - `ContentType`: `mime.lookup(file) || "application/octet-stream"` — wrong types = browser won't run your JS.
  - `CacheControl`: `index.html` → `"no-cache"`; files under `assets/` (hashed names) → `"public, max-age=31536000, immutable"`.
- Upload with limited concurrency (e.g. 8 at a time), not one-by-one and not all at once.
- Guard: refuse if output has > 5,000 files or > 100 MB total → user failure.

### Graceful shutdown
On SIGINT/SIGTERM: set `shuttingDown = true`, let the current job finish (or kill it and **don't** XACK — it'll be retried), then `quit()` both Redis clients.

---

## 2.5 Test it

Terminal 1: `pnpm --filter upload-service dev`
Terminal 2: `pnpm --filter deploy-service dev`
Terminal 3:

```powershell
function Deploy($url) {
  $r = Invoke-RestMethod -Method Post http://localhost:3002/deploy -ContentType application/json -Body (@{repoUrl=$url} | ConvertTo-Json)
  $r.id
}
$id = Deploy "https://github.com/RoyRao2333/template-vite-react-ts-tailwind"
while ($true) { $s = Invoke-RestMethod http://localhost:3002/status/$id; $s.status; if ($s.status -in "deployed","failed") { $s; break }; Start-Sleep 3 }

aws s3 ls s3://vercel-clone-chaitanya/dist/$id/ --recursive   # if you have the AWS CLI
```

| Scenario | Expected |
|---|---|
| `RoyRao2333/template-vite-react-ts-tailwind` | `deployed`, files in `dist/<id>/` with correct content types |
| `xyflow/vite-react-flow-template` (has a TS error at its current commit) | `failed`, "Build failed (exit 2)", XACKed, **not retried** |
| `43l3ypq6r0` already in the stream (vite-plugin-react monorepo) | `failed` — no static output |
| a non-JS repo, e.g. `github/gitignore` | `failed`, "No package.json at repo root" |
| Kill the worker (Ctrl+C twice) mid-build, restart it | job is picked up again after the claim timeout (lower it to ~30 s while testing) |
| Stop Docker Desktop, deploy, start Docker | infra failure → not acked → retried, eventually succeeds |
| `docker ps -a` after all tests | no leftover `build-*` containers |

---

## ✅ Phase 2 Done Checklist

- [ ] `.gitattributes` added; `build.sh` has LF endings
- [ ] `vercel-clone-builder` image builds; manual `docker create/start/cp` works
- [ ] Worker creates the consumer group on first boot and ignores `BUSYGROUP` after
- [ ] Successful repo → `deployed`, files in S3 with correct `Content-Type`
- [ ] Broken repo → `failed` with a useful message, acked, not retried
- [ ] Crashed worker's job is reclaimed; job delivered > 3 times is marked failed
- [ ] No temp dirs or `build-*` containers left behind
- [ ] Container never receives AWS keys (`docker inspect build-<id>` → check `Config.Env`)
- [ ] Every file has its header doc comment
- [ ] `pnpm check-types` and `pnpm build` pass
- [ ] Commit: `feat(deploy-service): sandboxed docker builds, upload to s3`

### Stretch (nice for Phase 4's UI)
Push each build log line to a Redis list `deployment:<id>:logs` (`RPUSH` + `LTRIM -500 -1`) so the frontend can show live build logs like Vercel does.

Next: **Phase 3 — request-handler** serves `http://<id>.localhost:3001` straight from `dist/<id>/` in S3.
