# Local Development — manhwa-scanner

> How to set up and run the monorepo locally. For full backend config reference, see [apps/backend/README.md](../apps/backend/README.md).

## Prerequisites

- Node.js 20+ and pnpm
- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- PostgreSQL (local or Supabase pooler)
- Redis (local or remote)

## Initial setup

```bash
# 1. Clone
git clone <repo-url> manhwa-scanner && cd manhwa-scanner

# 2. Frontend dependencies
pnpm install

# 3. Backend dependencies
cd apps/backend
uv sync
```

## Environment variables

Create `apps/backend/.env`:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DASHBOARD_PASSWORD` | **YES** | Single admin password (full admin) |
| `AUTH_SECRET` | **YES** | HS256 JWT signing secret |
| `DATABASE_URL` | **YES** | PostgreSQL transaction-pooler DSN |
| `DISCORD_BOT_TOKEN` | **YES** | Discord bot token (dispatches + slash commands) |
| `CRON_SECRET` | **YES** | Shared secret for `POST /api/cron` |
| `MONITOR_AUTH_TOKEN` | no | Alias for `DASHBOARD_PASSWORD` (monitor auth) |
| `PUBLIC_BASE_URL` | no | Public base for absolute links/embeds |
| `IKIRU_BASE_URL` | no | ikiru site root (default `https://07.ikiru.wtf/`) |
| `SECONDARY_SOURCE_URL` | no | shinigami API base (default `https://api.shngm.io`) |
| `SECONDARY_PUBLIC_BASE` | no | shinigami public site base |
| `VORATOON_API_URL` | no | voratoon API base (default `https://api.voratoon.com`) |
| `VORATOON_FALLBACK_URL` | no | voratoon fallback (default `https://be.komikcast.cc`) |
| `RSS_LOOKBACK_HOURS` | no | Feed window (default `24`) |
| `REDIS_URL` | no | Redis queue URL (default `redis://localhost:6379/0`) |
| `ENVIRONMENT` | no | `production` / `development` (guard bypass) |

**Boot guard** (`app/config.py`): production refuses to start without `CRON_SECRET`, `MONITOR_AUTH_TOKEN`, `AUTH_SECRET`, `DATABASE_URL`, and `DISCORD_BOT_TOKEN`. Set `ENVIRONMENT=development` to bypass.

## Running locally

```bash
# Terminal 1 — Frontend (http://localhost:3000)
pnpm --filter manhwa-reader dev

# Terminal 2 — Backend (http://localhost:8000)
cd apps/backend
ENVIRONMENT=development uv run uvicorn app.main:app --reload

# Terminal 3 — Cron worker (optional, local testing)
cd apps/backend
ROLE=cron ENVIRONMENT=development uv run python app/main.py
```

## Lint, typecheck, test

```bash
# Frontend
pnpm --filter manhwa-reader typecheck
pnpm --filter manhwa-reader test

# Backend
cd apps/backend
uv run ruff check app           # lint (line-length 100, E/F/B/E722)
uv run ruff format --check app  # formatting
uv run pytest                   # tests (testpaths=tests)
```

## Local pipeline test

```bash
cd apps/backend
ENVIRONMENT=development uv run python -c "
from app.cron.pipeline import run_pipeline
print(run_pipeline(do_dispatch=False))
"
```

## Database migrations

Migrations live in `apps/backend/app/db/migrations/` (numbered SQL files). Run in order against your local Postgres. Key tables: `recent_chapters`, `whitelist`, `dispatch_history`, `series_meta`, `excluded_titles`, `continue_reading`.

## Open API schema

```bash
# Generate from running backend
curl http://localhost:8000/api/openapi.json > apps/backend/openapi.json

# Sync to shared package
node packages/shared/scripts/generate.js
```
