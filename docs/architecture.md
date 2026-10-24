# Architecture

How the Vercel clone works end to end: what each service does, how a deploy flows
through the system, and how a deployed site is served. Diagrams are Mermaid, so
they render on GitHub and in VS Code's Markdown preview.

> Status: Phases 0–3 are implemented (upload-service, deploy-service, request-handler).
> The web frontend (Phase 4) and production hosting (Phase 5) are planned and drawn dashed.

---

## 1. System architecture

```mermaid
flowchart LR
    user(["User's browser"])

    subgraph trusted["Our infrastructure (trusted)"]
        direction TB
        web["web<br/>Next.js frontend<br/>:3000 (Phase 4)"]
        upload["upload-service<br/>Express API<br/>:3002"]
        deploy["deploy-service<br/>stream worker"]
        handler["request-handler<br/>Express<br/>:3001"]
        redis[("Redis<br/>deployment:{id} hash<br/>deployment:{id}:logs list<br/>deploy:stream")]
        s3[("S3 bucket<br/>dist/{id}/...")]
    end

    subgraph sandbox["Builder container (UNTRUSTED, one per build)"]
        builder["build.sh<br/>download → install → build"]
    end

    subgraph external["External services"]
        ghapi["GitHub REST API<br/>api.github.com"]
        codeload["GitHub tarballs<br/>codeload.github.com"]
        npm["npm registry"]
    end

    user -. "paste repo URL" .-> web
    web -. "POST /deploy, GET /status/:id" .-> upload
    user -- "POST /deploy, GET /status/:id" --> upload
    upload -- "repo public? size? → commit SHA" --> ghapi
    upload -- "MULTI: HSET record + XADD job" --> redis

    deploy -- "XREADGROUP / XACK / XAUTOCLAIM" --> redis
    deploy -- "status + build logs" --> redis
    deploy -- "docker create / start / cp / rm" --> builder
    builder -- "tarball @ sha" --> codeload
    builder -- "npm / pnpm / yarn install" --> npm
    deploy -- "PutObject each file" --> s3

    user -- "GET http://{id}.localhost:3001/..." --> handler
    handler -- "status lookup (cached)" --> redis
    handler -- "GetObject / HeadObject" --> s3

    classDef planned stroke-dasharray: 5 5
    class web planned
    classDef danger fill:#3b0d0d,stroke:#f87171,color:#fecaca
    class builder danger
```

### Services

| Service | Port | Role | Talks to |
|---|---|---|---|
| **web** *(Phase 4)* | 3000 | UI: paste a repo URL, watch status + logs, get the link | upload-service |
| **upload-service** | 3002 | Validate the repo, pin the commit SHA, record + enqueue the deployment | GitHub API, Redis |
| **deploy-service** | — | Worker: build each job in a sandbox, upload output, update status | Redis, Docker, S3 |
| **request-handler** | 3001 | Serve `<id>.<domain>` from S3 | Redis, S3 |
| **builder container** | — | Runs ONE untrusted build, then is deleted | GitHub tarballs, npm |

### Trust boundaries

| | Our services | Builder container |
|---|---|---|
| Runs whose code? | ours | **the user's** (install scripts, build script) |
| AWS credentials | ✅ (env locally, IAM role in prod) | ❌ never |
| Redis access | ✅ | ❌ |
| Host filesystem | ✅ | ❌ no bind mounts; output leaves only via `docker cp` |
| Limits | — | 1 CPU, 1 GB RAM, 512 pids, no capabilities, no-new-privileges, timeout |

---

## 2. Deploy flow (one deployment, start to finish)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UP as upload-service
    participant GH as GitHub API
    participant R as Redis
    participant W as deploy-service
    participant B as Builder container
    participant S3 as S3

    U->>UP: POST /deploy {repoUrl}
    UP->>UP: zod + strict github.com regex (blocks SSRF)
    UP->>GH: GET /repos/owner/repo
    GH-->>UP: private, size, default_branch
    UP->>GH: GET /repos/owner/repo/commits/default_branch
    GH-->>UP: sha (pins the exact commit)
    UP->>R: MULTI → HSET deployment:id {status queued} + XADD deploy:stream {id, repoUrl, sha} → EXEC
    UP-->>U: 202 {id, status queued}

    loop every few seconds
        U->>UP: GET /status/:id
        UP->>R: HGETALL deployment:id
        UP-->>U: current status
    end

    W->>R: XREADGROUP (blocks until a job arrives)
    R-->>W: entry {id, repoUrl, sha}
    W->>R: HSET status building
    W->>B: docker create (limits, only TARBALL_URL) + start -a
    activate B
    B->>B: curl codeload tarball at sha, install deps, npm run build
    B-->>W: log lines (stored in deployment:id:logs)
    deactivate B
    Note over W,R: every 15 s: XCLAIM JUSTID heartbeat keeps ownership
    W->>B: docker cp /home/node/output, then docker rm -f

    alt build succeeded
        W->>R: HSET status uploading
        W->>S3: PutObject dist/id/... (content type + cache headers)
        W->>R: HSET status deployed
        W->>R: XACK
    else user's build failed (BuildError)
        W->>R: HSET status failed + error message
        W->>R: XACK (no retry, the same commit would fail again)
    else our infrastructure failed (Docker, S3, Redis)
        W->>R: HSET status queued, NO XACK
        Note over W,R: entry stays pending, reclaimed and retried (max 3 deliveries)
    end
```

### Deployment status lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued: POST /deploy
    queued --> building: worker picks up job
    building --> uploading: build OK
    uploading --> deployed: all files in S3
    building --> failed: BuildError (bad code, no output, OOM, timeout)
    uploading --> failed: output too large / no index.html
    building --> queued: infra error or shutdown (retried)
    uploading --> queued: infra error (retried)
    queued --> failed: delivered more than 3 times
    deployed --> [*]
    failed --> [*]
```

---

## 3. The job queue (Redis Streams, no BullMQ)

```mermaid
flowchart TB
    xadd["upload-service<br/>XADD deploy:stream"] --> stream[("deploy:stream<br/>consumer group: deploy-workers")]
    stream -- "XREADGROUP '>'<br/>new entries" --> worker["worker loop"]
    worker --> pending["entry is PENDING<br/>(owned by this consumer)"]
    pending -- "heartbeat every 15 s<br/>XCLAIM JUSTID" --> pending
    pending -- "finished: deployed OR user failure" --> ack["XACK → removed from pending"]
    pending -- "worker crashed<br/>(no heartbeat for 60 s)" --> stale["stale pending entry"]
    stale -- "XAUTOCLAIM by another worker<br/>delivery count +1" --> worker
    pending -- "infra error → no XACK" --> stale
    worker -- "delivery count > 3" --> giveup["status failed + XACK"]
```

Why each piece exists:

| Mechanism | Prevents |
|---|---|
| Consumer group | two workers building the same deployment |
| Pending list + XACK | losing a job when a worker crashes mid-build |
| XAUTOCLAIM after 60 s idle | a crashed worker's job waiting forever |
| Heartbeat (XCLAIM JUSTID) | a healthy long build being stolen by another worker |
| Delivery count limit (3) | one poison job retrying forever |
| `MULTI` (HSET + XADD) | a status record without a job, or a job without a record |
| Commit SHA in the job | building different code than what was validated (TOCTOU) |
| `MAXLEN ~ 10000` | the stream growing forever |

---

## 4. Serving a deployed site (request-handler)

```mermaid
flowchart TB
    req["GET http://{id}.localhost:3001/path"] --> host{"Host is<br/>{10-char id}.BASE_DOMAIN?"}
    host -- no --> own["own routes: /health, else 404 JSON"]
    host -- yes --> method{"GET or HEAD?"}
    method -- no --> m405["405 Allow: GET, HEAD"]
    method -- yes --> status{"status in Redis<br/>(cached 60 s / 2 s)"}
    status -- missing --> p404["404 Deployment not found"]
    status -- failed --> pfail["404 Deployment failed"]
    status -- "queued / building / uploading" --> p503["503 in progress<br/>(auto-refresh)"]
    status -- deployed --> path{"resolve path"}
    path -- "'..', NUL, bad %-encoding" --> p400["400 Bad request"]
    path -- "/ or ends with /" --> k1["try path/index.html"]
    path -- "has extension: /assets/app.js" --> k2["try exact key only"]
    path -- "no extension: /about" --> k3["try about, about.html,<br/>about/index.html,<br/>then index.html (SPA)"]
    k1 --> s3get["S3 GetObject dist/{id}/key<br/>with If-None-Match"]
    k2 --> s3get
    k3 --> s3get
    s3get -- found --> stream200["200: stream body<br/>Content-Type, Cache-Control, ETag"]
    s3get -- "ETag matches" --> r304["304 Not Modified"]
    s3get -- "no key matched" --> f404["404 file not found"]
```

Caching strategy (set by deploy-service at upload, forwarded by request-handler):

| File | Cache-Control | Why |
|---|---|---|
| `*.html` | `no-cache` | always revalidate, so a new deploy shows up |
| `assets/*` | `public, max-age=31536000, immutable` | Vite puts a content hash in the filename |
| everything else | `public, max-age=3600` | favicons, images without hashes |

---

## 5. Data layout

### Redis

| Key | Type | Written by | Read by | Contents |
|---|---|---|---|---|
| `deployment:<id>` | hash | upload-service, deploy-service | upload-service, request-handler | `id, repoUrl, sha, status, createdAt, updatedAt, error?` |
| `deployment:<id>:logs` | list | deploy-service | (web, Phase 4) | last 1000 build log lines, 7-day TTL |
| `deploy:stream` | stream | upload-service | deploy-service | `{id, repoUrl, sha}` per entry |

### S3 (`vercel-clone-chaitanya`, us-east-1)

```text
dist/
  <id>/
    index.html
    assets/index-<hash>.js
    assets/index-<hash>.css
    vite.svg
```

---

## 6. Repository layout

```text
apps/
  upload-service/    Express API: POST /deploy, GET /status/:id
  deploy-service/    stream worker + builder/ (Dockerfile, build.sh)
  request-handler/   serves <id>.<BASE_DOMAIN> from S3
  web/               (Phase 4) Next.js frontend
packages/
  shared/            constants, types, zod schemas, stream encoding
  typescript-config/ shared tsconfig presets
  eslint-config/     shared ESLint config
docs/                phase plans + this file
docker-compose.yml   local Redis
```

---

## 7. Production topology (planned, Phase 5)

```mermaid
flowchart LR
    user(["Users"]) --> dns["DNS<br/>app.example.com<br/>*.example-sites.com"]
    dns --> cf["CloudFront CDN"]
    cf --> alb["Application Load Balancer"]
    alb --> webp["web<br/>(ECS / Vercel)"]
    alb --> upp["upload-service<br/>(ECS Fargate)"]
    alb --> rhp["request-handler<br/>(ECS Fargate)"]
    upp --> ec["ElastiCache Redis"]
    rhp --> ec
    rhp --> s3p[("S3")]
    subgraph ec2["EC2 build host(s) with Docker"]
        dsp["deploy-service"] --> bc["builder containers"]
    end
    dsp --> ec
    dsp --> s3p
    ecr[("ECR<br/>builder image")] --> ec2

    classDef planned stroke-dasharray: 5 5
    class dns,cf,alb,webp,upp,rhp,ec,s3p,dsp,bc,ecr planned
```

Notes for production:

- **Serve user sites from a separate domain** (like `vercel.app` vs `vercel.com`). User sites on subdomains of the main app's domain could read or set cookies for the app.
- **deploy-service needs a Docker daemon**, so it runs on EC2, not plain Fargate. To make builds serverless, swap `apps/deploy-service/src/docker.ts` for ECS `RunTask`; nothing else changes.
- **IAM roles, not keys.** upload-service needs no AWS access. deploy-service needs `PutObject` on `dist/*`. request-handler needs `GetObject` + `ListBucket` (without `ListBucket`, missing files return 403 instead of 404).
- **CloudFront in front of request-handler** caches `immutable` assets at the edge, so most requests never reach our servers.
