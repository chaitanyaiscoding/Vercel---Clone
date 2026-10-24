# Phase 1 — upload-service

**Goal:** `POST /deploy { repoUrl }` validates a public GitHub repo, pins it to a commit SHA, records the deployment in Redis, and enqueues a BullMQ job. `GET /status/:id` returns the current status. No files are downloaded here (Option B).

```
POST /deploy ──► zod validate ──► parse owner/repo ──► GitHub API: public? size ok? default branch → SHA
                                                              │
                                    Redis HSET deployment:<id> {status: queued, repoUrl, sha, ...}
                                                              │
                                    BullMQ queue.add("deploy", { id, repoUrl, sha })  ──► 202 { id }
```

> **Update:** BullMQ was replaced with raw **Redis Streams**. The upload-service publishes with `MULTI` → `HSET deployment:<id>` + `XADD deploy:stream`. Wherever this doc says BullMQ/`queue.add`, read `enqueueDeployment()` in `src/queue.ts`. Stream names live in `@repo/shared` (`DEPLOY_STREAM`, `DEPLOY_CONSUMER_GROUP`).

---

## 1.1 Install dependencies

```powershell
pnpm --filter upload-service add express cors zod bullmq ioredis nanoid
pnpm --filter upload-service add -D @types/express @types/cors
pnpm --filter @repo/shared add zod
```

Fill in `apps/upload-service/.env` (copy from `.env.example`):

```
PORT=3002
REDIS_URL=redis://localhost:6379
GITHUB_TOKEN=
```

> `GITHUB_TOKEN` is optional. Without it GitHub allows **60 API requests/hour per IP**; each deploy uses 2. Create a fine-grained token with **no permissions** (public read only) when you hit the limit — 5,000/hour.

---

## 1.2 Shared contracts — `packages/shared`

Put anything the frontend, upload-service and deploy-service must agree on here.

**`src/constants.ts`** — add:

```ts
export const DEPLOY_QUEUE = "deploy-queue";
export const MAX_REPO_SIZE_KB = 100 * 1024; // 100 MB (GitHub reports size in KB)

export const deploymentKey = (id: string) => `deployment:${id}`;
```

**`src/types.ts`** — add a record type for what we store in Redis:

```ts
export interface DeploymentRecord {
  id: string;
  repoUrl: string;
  sha: string;
  status: DeploymentStatus;
  createdAt: string; // ISO
  error?: string;
}
```

**`src/schemas.ts`** (new) — request validation, reused by the frontend in Phase 4:

```ts
import { z } from "zod";

export const GITHUB_URL_REGEX =
  /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export const deployRequestSchema = z.object({
  repoUrl: z.string().trim().regex(GITHUB_URL_REGEX, "Must be https://github.com/<owner>/<repo>"),
});

export type DeployRequest = z.infer<typeof deployRequestSchema>;
```

Export it from `src/index.ts`.

🤔 **Think about:** why do we restrict to `https://github.com/...` with a strict regex instead of accepting any URL and letting `fetch` figure it out? (Hint: SSRF — the server would otherwise make requests to whatever host a user types, including `http://169.254.169.254` on AWS.)

---

## 1.3 File layout

```
apps/upload-service/src/
  index.ts        → create express app, mount routes, listen
  env.ts          → parse & validate process.env with zod (fail fast at boot)
  redis.ts        → single shared ioredis connection
  queue.ts        → BullMQ Queue instance
  github.ts       → parseRepoUrl(), getRepoInfo(), getLatestSha()
  errors.ts       → HttpError class (status + message)
  routes/
    deploy.ts     → POST /deploy, GET /status/:id
```

---

## 1.4 Implementation notes (write these yourself)

### `env.ts`
- `z.object({ PORT: z.coerce.number().default(3002), REDIS_URL: z.string().url(), GITHUB_TOKEN: z.string().optional() })`
- `export const env = schema.parse(process.env)` — the app crashes on boot with a clear message if config is wrong. Much better than a mystery `undefined` later.
- Gotcha: an empty `GITHUB_TOKEN=` line gives `""`, not `undefined`. Handle it (`.transform(v => v || undefined)`).

### `redis.ts` / `queue.ts`
- `new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })` — BullMQ **requires** `maxRetriesPerRequest: null` (it will warn/throw otherwise).
- `new Queue<DeployJob>(DEPLOY_QUEUE, { connection: redis })`
- Default job options worth setting:
  - `jobId: id` → BullMQ dedupes by id, so a double-submit can't enqueue twice
  - `attempts: 2`, `backoff: { type: "exponential", delay: 5000 }`
  - `removeOnComplete: 1000`, `removeOnFail: 5000` → Redis doesn't grow forever

### `github.ts`
Two calls with `fetch` (built into Node 24 — no axios needed):

1. `GET https://api.github.com/repos/{owner}/{repo}`
   - Use: `private`, `size` (KB), `default_branch`
   - **404** → repo doesn't exist **or is private** (GitHub hides private repos as 404). Treat both as "not found or private".
2. `GET https://api.github.com/repos/{owner}/{repo}/commits/{default_branch}`
   - Use: `sha`

Headers on every request:

```ts
{
  Accept: "application/vnd.github+json",
  "User-Agent": "vercel-clone",           // GitHub rejects requests without one
  "X-GitHub-Api-Version": "2022-11-28",
  ...(env.GITHUB_TOKEN && { Authorization: `Bearer ${env.GITHUB_TOKEN}` }),
}
```

Also handle **403/429** (rate limited) → return 503 to the user, not 500.

Don't trust the response shape blindly — parse it with a small zod schema (`z.object({ private: z.boolean(), size: z.number(), default_branch: z.string() })`).

### `routes/deploy.ts`

`POST /deploy`
1. `deployRequestSchema.safeParse(req.body)` → 400 on failure
2. Extract `owner`, `repo` from regex match groups
3. `getRepoInfo` → reject `private` (404) or `size > MAX_REPO_SIZE_KB` (413)
4. `getLatestSha`
5. `id = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10)()` — lowercase only, because it becomes a **subdomain** (DNS is case-insensitive)
6. `redis.hset(deploymentKey(id), record)` — store the record **before** enqueueing (why? the worker may pick up the job instantly and try to update a record that doesn't exist yet)
7. `queue.add("deploy", { id, repoUrl, sha }, { jobId: id })`
8. Respond **`202 Accepted`** `{ id, status: "queued" }` — 202 means "accepted, processing later", which is exactly true

`GET /status/:id`
- Validate `id` matches `/^[0-9a-z]{10}$/` before touching Redis
- `redis.hgetall(deploymentKey(id))` → empty object means 404
- Return the record

### `index.ts`
- `app.use(cors({ origin: "http://localhost:3000" }))`, `app.use(express.json({ limit: "10kb" }))`
- A final error-handling middleware: `HttpError` → its status; anything else → log it, return 500 with a generic message (never leak stack traces)
- Graceful shutdown on `SIGINT`/`SIGTERM`: `server.close()`, `queue.close()`, `redis.quit()`

> Express 5 (what pnpm installs today) forwards errors thrown in `async` handlers to your error middleware automatically — no `try/catch` + `next(err)` boilerplate needed.

---

## 1.5 Test it (PowerShell)

```powershell
pnpm --filter upload-service dev
```

In another terminal:

```powershell
# happy path — a small public Vite repo
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3002/deploy `
  -ContentType "application/json" `
  -Body '{"repoUrl":"https://github.com/vitejs/vite-plugin-react"}'
$r

Invoke-RestMethod http://localhost:3002/status/$($r.id)

# inspect Redis directly
docker exec vercel-redis redis-cli HGETALL "deployment:$($r.id)"
docker exec vercel-redis redis-cli KEYS "bull:deploy-queue:*"
```

Error cases you must check:

| Input | Expected |
|---|---|
| `{"repoUrl":"https://gitlab.com/a/b"}` | 400 |
| `{"repoUrl":"https://github.com/torvalds"}` | 400 |
| `{"repoUrl":"https://github.com/you/does-not-exist-xyz"}` | 404 |
| a huge repo, e.g. `https://github.com/torvalds/linux` | 413 |
| `{}` or invalid JSON | 400 |
| `GET /status/abc` | 400 or 404, never 500 |
| Submit same request twice quickly | two different ids (fine) — but same id can never be queued twice |

---

## ✅ Phase 1 Done Checklist

- [ ] App refuses to boot with a clear error if `REDIS_URL` is missing
- [ ] Happy path returns `202 { id, status: "queued" }`
- [ ] `HGETALL deployment:<id>` shows the record with a 40-char `sha`
- [ ] A waiting job exists in `bull:deploy-queue:wait`
- [ ] Every row in the error table behaves as expected
- [ ] `pnpm check-types` and `pnpm build` pass
- [ ] Commit: `feat(upload-service): validate repo, pin sha, enqueue deploy job`

Next: **Phase 2 — deploy-service** picks up that job, runs the build in a locked-down Docker container, and uploads `dist/` to `s3://vercel-clone-chaitanya/dist/<id>/`.
