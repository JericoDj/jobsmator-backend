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
| `bun run db:generate` / `db:migrate` / `db:studio` | Drizzle |
| `bun run sync:web` | copy `src/contracts/index.ts` into `../jobsmator-web/lib/contracts.ts` |

## Endpoints

`GET /health` · `GET|PATCH /v1/me` · `POST|GET /v1/resumes` · `DELETE /v1/resumes/:id` ·
`POST|GET /v1/runs` · `GET /v1/runs/:id` · `GET /v1/runs/:id/jobs` · `GET /v1/jobs/saved` ·
`POST /v1/jobs/:id/save` · `POST /v1/jobs/:id/hide`

All `/v1/*` routes need `Authorization: Bearer <Firebase ID token>`.
