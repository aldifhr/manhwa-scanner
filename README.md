# manhwa-scanner

Monorepo: **Next.js frontend** (`apps/frontend`) + **FastAPI backend** (`apps/backend`). Scrapes chapter releases from ikiru, shinigami, and voratoon sources into a 24h rolling feed, filters against a whitelist, and dispatches new chapters to Discord. `komik.aldifhr.fun` (FE) → `scanner.aldifhr.fun` (BE).

## Architecture

Two-pass cron pipeline: **rss-fetch** (scrape + persist to PostgreSQL) → **dispatch** (whitelist filter → Discord). Storage via psycopg2 connection pool, Redis-backed task queue for cron jobs. See [docs/architecture.md](docs/architecture.md) for the full data flow, table catalog (12 tables), and index map.

## Quick start

```bash
# Clone
git clone <repo-url> manhwa-scanner && cd manhwa-scanner

# Frontend
pnpm install
pnpm --filter manhwa-reader dev        # http://localhost:3000

# Backend
cd apps/backend
uv sync
cp .env.example .env                   # set DASHBOARD_PASSWORD, DATABASE_URL, etc.
ENVIRONMENT=development uv run uvicorn app.main:app --reload  # http://localhost:8000
```

## Docs

- [docs/architecture.md](docs/architecture.md) — data flow, tables, indexes, retention
- [docs/local-development.md](docs/local-development.md) — env vars, local run, lint, test
- [docs/deployment.md](docs/deployment.md) — PM2, Caddy, deploy.sh, Vercel
- [docs/api.md](docs/api.md) — endpoint overview (full schema: `apps/backend/openapi.json`)
- [docs/sources.md](docs/sources.md) — ikiru/shinigami/voratoon, fallback chains, type mapping
- [docs/security.md](docs/security.md) — auth, CSRF, JWT, P0 findings

## References

- [apps/backend/README.md](apps/backend/README.md) — backend-specific setup, config, cron
- [CONTEXT.md](CONTEXT.md) — domain glossary, roles, routes, deep modules
- [BUG.md](BUG.md) — known issues and security findings
