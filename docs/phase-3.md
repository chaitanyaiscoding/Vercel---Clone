# Phase 3 — request-handler

**Goal:** Serve every deployed site at `http://<id>.localhost:3001` straight from `s3://vercel-clone-chaitanya/dist/<id>/`.

> ✅ Implemented & tested (2026-10-24). Diagrams: see [architecture.md §4](architecture.md#4-serving-a-deployed-site-request-handler).

## How a request is handled

1. **Which deployment?** `Host: worya03809.localhost` → id `worya03809` (must be exactly one 10-char label before `BASE_DOMAIN`).
2. **Can it be served?** Status from Redis (cached 60 s when deployed, 2 s otherwise):
   missing → 404 page · `failed` → 404 page · `queued/building/uploading` → 503 page that refreshes every 5 s.
3. **Which file?** `resolve.ts` maps the path to S3 keys to try in order:
   - `/` or `/docs/` → `index.html` / `docs/index.html`
   - `/assets/app.js` (has extension) → that exact key, else 404 — a missing JS file must never get HTML back
   - `/about` (no extension) → `about`, `about.html`, `about/index.html`, then **`index.html`** (SPA fallback for client-side routers)
   - `..`, NUL, backslash, bad `%` encoding → 400
4. **Stream it** from S3 with the `Content-Type`, `Cache-Control` and `ETag` the deploy-service set at upload. The browser's `If-None-Match` is forwarded, so unchanged files return **304** without re-downloading.

## Files (`apps/request-handler/src/`)

| File | What it does |
|---|---|
| `index.ts` | boot, Express app, security headers, `/health`, error handler, graceful shutdown |
| `env.ts` | zod-validated config (`PORT`, `REDIS_URL`, `AWS_REGION`, `S3_BUCKET`, `BASE_DOMAIN`, `TRUST_PROXY`) |
| `redis.ts` | Redis client + fail-fast boot check |
| `deployment.ts` | host → deployment id; cached status lookup |
| `resolve.ts` | URL path → candidate S3 keys (+ SPA fallback) |
| `s3.ts` | `GetObject` (with 304 support) and `HeadObject` |
| `serve.ts` | the handler tying it all together |
| `pages.ts` | built-in HTML for not found / building / failed / errors |

Shared changes: deployment id rules (`DEPLOYMENT_ID_*`) and the S3 layout (`deploymentFilesPrefix`) moved to `@repo/shared`, so all three services agree.

## Run it

```powershell
pnpm --filter request-handler dev
# then open a deployed id in the browser:
start http://worya03809.localhost:3001
```

## Test results

| Request | Result |
|---|---|
| `/` | 200 `text/html`, `no-cache` |
| `/assets/*.js`, `*.css` | 200 correct MIME, `immutable`, byte-identical to S3 |
| `/about` | 200 `index.html` (SPA fallback) |
| `/missing.js` | 404 |
| `/..%2f..%2fetc`, `/%E0%A4%A` | 400 |
| `HEAD /` | 200 headers only |
| `POST /` | 405 `Allow: GET, HEAD` |
| `If-None-Match: <etag>` | 304 |
| failed / unknown / building deployment | 404 / 404 / 503 |
| `localhost:3001/health` | 200 |
| headers | `X-Content-Type-Options: nosniff`, no `X-Powered-By` |

## Production notes

- Put **CloudFront** in front: `immutable` assets get cached at the edge and never reach this service.
- Serve user sites from a **separate domain** from the main app (cookie isolation).
- The IAM role needs `s3:GetObject` **and** `s3:ListBucket`, otherwise missing files return 403 instead of 404.
- Set `TRUST_PROXY=true` behind a load balancer so `req.hostname` uses the forwarded host.
