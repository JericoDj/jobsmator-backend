# jobsmator-backend

Bun + Hono API for JobsMator. The only service that talks to the n8n matching engine.
Architecture: see [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (or the `jobsmator` meta repo).

## Run locally

```bash
cp .env.example .env        # fill in DATABASE_URL, N8N_*, FIREBASE_*
bun install
bun run db:generate         # creates SQL migration from src/db/schema.ts (first time + on schema changes)
bun run db:migrate
bun run dev                 # http://localhost:3001/health
```

Postgres for local dev: `docker compose up postgres` from the parent folder.

## Scripts

| Script | What |
|---|---|
| `bun run dev` | watch mode |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | unit tests (no DB needed) |
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle |
| `bun run sync:web` | copy `src/contracts/index.ts` into `../jobsmator-web/lib/contracts.ts` |

## API docs

Interactive reference (Scalar): **http://localhost:3001/docs** · raw spec: `/openapi.json` (OpenAPI 3.1, generated from the zod schemas).
All `/v1/*` routes need `Authorization: Bearer <Firebase ID token>`.

## Modules

| Module | Path | Responsibility | Endpoints |
|---|---|---|---|
| **Entry / docs** | `src/index.ts` | Hono app, middleware order, route mounting, OpenAPI + Scalar | `GET /openapi.json`, `GET /docs` |
| **System** | `src/routes/health.ts` | Liveness + DB check for Railway | `GET /health` |
| **Auth middleware** | `src/middleware.ts` | Verifies Firebase ID token, upserts `users`, request IDs | — |
| **Me** | `src/routes/me.ts` | Profile, default preferences, account deletion | `GET/PATCH/DELETE /v1/me` |
| **Resumes** | `src/routes/resumes.ts` | Registers files uploaded to Firebase Storage, soft-delete + object delete | `POST/GET /v1/resumes`, `DELETE /v1/resumes/:id` |
| **Runs** | `src/routes/runs.ts` | Async search runs: rate limits, background engine call, persistence | `POST/GET /v1/runs`, `GET /v1/runs/:id` |
| **Jobs** | `src/routes/jobs.ts` | Paged ranked results, saved list, save/hide/applied toggles | `GET /v1/runs/:id/jobs`, `GET /v1/jobs/saved`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/{save,hide,applied}` |
| **Engine client** | `src/services/engine.ts` | The only n8n caller; secret header, timeout, error mapping, zod-parsed response | — |
| **Storage** | `src/services/storage.ts` | 15-min signed resume URLs, object deletion | — |
| **Firebase Admin** | `src/services/auth.ts` | Admin SDK init from base64 service account | — |
| **Contracts** | `src/contracts/index.ts` | zod schemas shared with web (`bun run sync:web`) and the OpenAPI spec | — |
| **DB** | `src/db/{schema,client,migrate}.ts`, `migrations/` | Drizzle schema (`users, resumes, runs, jobs, job_actions`), migrations applied on boot | — |
| **Maintenance** | `src/jobs/maintenance.ts` | Sweeps stale runs every minute; purges raw engine payloads after 7 days | — |
| **Lib** | `src/lib/{env,errors,logger,openapi}.ts` | Typed env, stable error codes, pino, `route()` OpenAPI helper | — |
| **Firebase rules** | `firebase/storage.rules` | Per-user `resumes/{uid}/**` rules (deploy from the Firebase project) | — |
| **Tests / CI** | `test/*.test.ts`, `.github/workflows/ci.yml` | `bun test`: contracts, engine error mapping, error handler; CI runs typecheck + tests + docker build | — |
