# Phase 4 — web frontend

**Goal:** A UI to paste a GitHub URL, watch the deployment progress with live build logs, and open the deployed site.

> ✅ Implemented & tested end to end in a real (headless Chromium) browser on 2026-10-24.

## Decisions

- **Vite + React 19, not Next.js.** The UI is fully client-side (no SEO, no server rendering needed), so a static build is enough. It can be hosted on S3 + CloudFront, or deployed **by this platform itself**.
- **Polling, not WebSockets/SSE.** Every 2 s: `GET /status/:id`, then `GET /status/:id/logs?from=<next>`. Simple, works through any proxy, and stops as soon as the deployment finishes.
- **Selected deployment lives in the URL** (`?d=<id>`): refresh, bookmark, share and the back button all work.
- **Recent deployments in localStorage** (no accounts yet), wrapped in try/catch so a blocked storage doesn't break the app.
- **Same validation as the server:** the form uses `deployRequestSchema` from `@repo/shared`.

## Backend changes this phase

| Change | Why |
|---|---|
| `GET /status/:id` now includes `url` | the backend is the one place that knows the public site address (`SITE_URL_TEMPLATE`) |
| New `GET /status/:id/logs?from=N` → `{ lines, next }` | incremental logs: the client only downloads new lines |
| deploy-service keeps `logCount` (total lines ever written) on the record, in the same `MULTI` as the push | the log list is trimmed to 1000 lines, which shifts list positions; paging by the absolute count stays correct |
| deploy-service flushes logs **before** writing the final status | the UI stops polling at `deployed`/`failed`; all lines must already be there |
| UI fetches status **then** logs (not in parallel) | together with the line above, guarantees the last log lines are never missed |

## Files (`apps/web/`)

| File | What it does |
|---|---|
| `index.html`, `vite.config.ts`, `src/main.tsx` | shell, Vite config (port 3000), React entry |
| `src/App.tsx` | layout, URL state (`?d=`), recent list wiring |
| `src/api.ts` | typed client for the upload-service API |
| `src/hooks/useDeployment.ts` | polls status + new log lines until finished |
| `src/components/DeployForm.tsx` | URL input with shared zod validation |
| `src/components/DeploymentView.tsx` | repo/commit header, progress steps, live link or error, logs |
| `src/components/LogViewer.tsx` | terminal-style logs, auto-scroll unless you scroll up |
| `src/components/StatusBadge.tsx`, `RecentList.tsx` | status pill, sidebar list |
| `src/lib/recent.ts`, `src/lib/format.ts` | localStorage helpers, display formatting |
| `src/styles.css` | light + dark theme (follows the OS), responsive layout |

## Run it

```powershell
pnpm dev                 # all apps, or:
pnpm --filter web dev    # just the UI on http://localhost:3000
```

`VITE_API_URL` (default `http://localhost:3002`) is baked in at **build** time. For production, set it before `pnpm --filter web build`.

## Test results (headless Chromium)

| Check | Result |
|---|---|
| Invalid URL | inline error from the shared schema; clears when you edit |
| Deploy example repo | id appears in the URL, status goes Queued → Building → Uploading → Ready |
| Live logs | all 40 lines arrive incrementally, last line `✓ uploaded 5 files` |
| "Visit" link | opens `http://<id>.localhost:3001`, which returns 200 with the built site |
| Reload | same deployment shown, recent list kept |
| 390 px wide, dark mode | no horizontal scroll, readable |
| Browser console | no errors |
| Logs API paging | `from=0/35/next` correct; trimmed list (3 of 10 lines kept) maps correctly; bad `from` → 400 |

Bugs found by testing and fixed: logs endpoint returned nothing for deployments created before `logCount` existed; the form's error message didn't clear while editing.
