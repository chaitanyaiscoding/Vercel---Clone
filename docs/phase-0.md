# Phase 0 — Monorepo & Local Infrastructure

**Goal:** A working Turborepo with 3 empty backend services + a frontend + a shared package, Redis running locally, and AWS ready for later phases. No business logic yet.

**Architecture decision (locked):** Option B — the upload-service does NOT store repo files. It validates the GitHub URL, resolves the commit SHA, and enqueues `{ id, repoUrl, sha }`. The build container downloads the repo itself.

---

## 0.1 Prerequisites

Run in PowerShell and confirm versions:

```powershell
node -v      # need v20+ (v22 LTS preferred)
pnpm -v      # if missing: npm install -g pnpm
docker -v    # Docker Desktop must be running
git --version
```

---

## 0.2 Scaffold Turborepo

> ⚠️ `create-turbo` refuses non-empty folders. This `docs/` folder makes it non-empty, so **temporarily move `docs` out** to the parent folder, scaffold, then move it back.

```powershell
cd E:\Chaitanya_Projects\october\vercel_clone
Move-Item docs ..\vercel_clone_docs
npx create-turbo@latest . --package-manager pnpm
Move-Item ..\vercel_clone_docs docs
```

Then clean up the template:

- Delete `apps/docs`
- **Keep `apps/web`** for now (Next.js). We'll decide Next vs Vite in Phase 4 — if Vite, we replace it then.
- Delete `packages/ui` (we'll add UI packages later only if needed)
- Keep `packages/typescript-config` and `packages/eslint-config`

```powershell
Remove-Item -Recurse -Force apps\docs, packages\ui
```

Remove any `@repo/ui` reference from `apps/web/package.json` and its imports in `apps/web/app/page.tsx` (replace the page with a simple `<h1>Vercel Clone</h1>`).

```powershell
git init
pnpm install
pnpm dev     # sanity check: web runs on localhost:3000, then Ctrl+C
```

---

## 0.3 Add a Node tsconfig preset

Create `packages/typescript-config/node.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "noEmit": true
  }
}
```

**Why `Bundler` + `noEmit`:** we run TS directly in dev with `tsx`, and bundle for production with `tsup`. `tsc` is only used for type-checking. This avoids the `.js`-extension-in-imports pain of `NodeNext`.

---

## 0.4 Create the shared package — `packages/shared`

```
packages/shared/
  package.json
  tsconfig.json
  src/
    index.ts
    constants.ts
    types.ts
```

`package.json` — a "just-in-time" internal package (exports TS source directly, no build step):

```json
{
  "name": "@repo/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check-types": "tsc"
  },
  "devDependencies": {
    "@repo/typescript-config": "workspace:*",
    "@types/node": "^22",
    "typescript": "^5"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "@repo/typescript-config/node.json",
  "include": ["src"]
}
```

`src/constants.ts`:

```ts
export const DEPLOY_QUEUE = "deploy-queue";
```

`src/types.ts`:

```ts
export type DeploymentStatus = "queued" | "building" | "uploading" | "deployed" | "failed";

export interface DeployJob {
  id: string;       // lowercase, subdomain-safe (we'll use nanoid custom alphabet)
  repoUrl: string;  // https://github.com/owner/repo
  sha: string;      // exact commit to build
}
```

`src/index.ts`:

```ts
export * from "./constants";
export * from "./types";
```

---

## 0.5 Create the 3 backend apps

Same skeleton for each of: `apps/upload-service`, `apps/deploy-service`, `apps/request-handler`.

```
apps/<name>/
  package.json
  tsconfig.json
  tsup.config.ts
  .env.example
  src/index.ts
```

`package.json` (change `name` per app):

```json
{
  "name": "upload-service",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/index.ts",
    "build": "tsup",
    "start": "node --env-file=.env dist/index.js",
    "check-types": "tsc"
  },
  "dependencies": {
    "@repo/shared": "workspace:*"
  },
  "devDependencies": {
    "@repo/typescript-config": "workspace:*",
    "@types/node": "^22",
    "tsup": "^8",
    "tsx": "^4",
    "typescript": "^5"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "@repo/typescript-config/node.json",
  "include": ["src"]
}
```

`tsup.config.ts` — bundles `@repo/shared` in, since it's TS source:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  noExternal: ["@repo/shared"],
});
```

`src/index.ts` (temporary smoke test):

```ts
import { DEPLOY_QUEUE } from "@repo/shared";

console.log(`[upload-service] booted, queue = ${DEPLOY_QUEUE}`);
```

Create an empty `.env` next to `.env.example` in each app (Node's `--env-file` errors if the file is missing).

### Ports & env plan

| App | Port | Env vars (fill in later phases) |
|---|---|---|
| web | 3000 | `NEXT_PUBLIC_API_URL=http://localhost:3002` |
| request-handler | 3001 | `AWS_*`, `S3_BUCKET` |
| upload-service | 3002 | `PORT`, `REDIS_URL`, `GITHUB_TOKEN` (optional) |
| deploy-service | — (worker) | `REDIS_URL`, `AWS_*`, `S3_BUCKET` |

> Deployed sites will be served at `http://<id>.localhost:3001` — Chrome/Edge resolve `*.localhost` to 127.0.0.1 automatically, no hosts-file edits needed.

---

## 0.6 Update `turbo.json`

Make sure tasks look like this (keep whatever else the template has):

```json
{
  "$schema": "https://turborepo.com/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", ".env*"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "check-types": {
      "dependsOn": ["^check-types"]
    },
    "lint": {
      "dependsOn": ["^lint"]
    }
  }
}
```

---

## 0.7 Local infrastructure — Redis via Docker Compose

Create `docker-compose.yml` at the repo root:

```yaml
services:
  redis:
    image: redis:7-alpine
    container_name: vercel-redis
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

```powershell
docker compose up -d
docker exec -it vercel-redis redis-cli ping   # → PONG
```

Also pre-pull the image the build sandbox will use in Phase 2:

```powershell
docker pull node:20-alpine
```

---

## 0.8 AWS setup (needed from Phase 2, do it now)

1. Create an S3 bucket, e.g. `vercel-clone-<yourname>` (region `ap-south-1` or nearest). Keep **Block all public access ON** — request-handler reads it with credentials.
2. Create IAM user `vercel-clone-dev` with **programmatic access only**, and attach an inline policy scoped to that bucket only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::vercel-clone-<yourname>",
        "arn:aws:s3:::vercel-clone-<yourname>/*"
      ]
    }
  ]
}
```

3. Save the access key ID + secret. **Never commit them** — they go only in `.env` files.

(Alternative: Cloudflare R2 — same S3 SDK, free egress. Just change the endpoint.)

---

## 0.9 Git hygiene

Ensure root `.gitignore` contains:

```
node_modules
dist
.next
.turbo
.env
.env.*
!.env.example
```

```powershell
git add .
git commit -m "chore: phase 0 monorepo scaffold"
```

---

## ✅ Phase 0 Done Checklist

- [ ] `pnpm install` succeeds at root
- [ ] `pnpm dev` starts all 4 apps; each backend logs `booted, queue = deploy-queue`
- [ ] `pnpm check-types` passes
- [ ] `pnpm build` produces `apps/*/dist/index.js` for the 3 backends
- [ ] `docker exec -it vercel-redis redis-cli ping` → `PONG`
- [ ] `node:20-alpine` image pulled
- [ ] S3 bucket + scoped IAM user created, keys stored safely
- [ ] First git commit made, no `.env` files committed

When all boxes are ticked, come back with your folder tree (`tree /F apps packages` minus node_modules) and we start **Phase 1: upload-service** (Express + GitHub API validation + SHA resolution + BullMQ producer).

---

## Phase 1 preview (don't build yet)

- `POST /deploy { repoUrl }` → validate with zod → parse owner/repo
- GitHub API: repo exists? public? size < limit? → resolve default branch → commit SHA
- Generate id (`nanoid` with lowercase alphabet, subdomain-safe)
- Redis: `HSET status <id> queued`
- BullMQ: `queue.add("deploy", { id, repoUrl, sha })`
- `GET /status/:id` → returns current status
