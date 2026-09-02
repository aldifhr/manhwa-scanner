# be-ag-py

Manga/manhwa tracker backend (`be-ag-py`). Scrapes chapter releases from
**ikiru**, **shinigami**, and **voratoon** sources into a 24-hour rolling feed,
filters them against a whitelist, and dispatches new chapters to Discord channels.

Python port of the original TypeScript (`lib/hono-app.ts`) service.

## Architecture

```
Internal cron scheduler (app/tasks.py, ROLE=cron)
        │  every 5m: rss-fetch  │  every 15m: enrich
        ▼                        ▼
┌────────────────────┐   scrape + persist   ┌────────────────────┐
│  rss-fetch pass    │ ───────────────────▶ │ recent_chapters    │
│  collect ikiru +   │   (24h rolling feed) │  (PostgreSQL)      │
│  shinigami +       │                      └─────────┬──────────┘
│  voratoon          │                                │ read
└────────────────────┘                                ▼
                        ┌────────────────────┐   whitelist filter   ┌────────────────────┐
                        │  dispatch pass     │ ───────────────────▶ │ dispatch to Discord│
                        │  (no re-scrape)    │                      │  + dispatch_history│
                        └────────────────────┘                      └────────────────────┘
```

- **Sources**: `ikiru` (gap-fill scanner: only fetches titles missing from
  shinigami/voratoon), `shinigami` (public REST API), `voratoon` (API + HTML fallback).
- **Storage**: direct PostgreSQL via psycopg2 connection pool.
  `app/db_adapter.py` exposes a builder API mirroring PostgREST/Supabase.
- **Queue**: Redis-backed durable task queue (`app/tasks.py`) for Discord
  add-to-whitelist jobs, with a dead-letter list and retry budget.
- **Covers**: direct source URLs proxied via `/api/reader/proxy`.

### Rating system

- All sources normalize ratings to a **1–10 float scale** via
  `app/services/rating_utils.py`.
- `rating` columns in `whitelist`, `recent_chapters`, and `series_meta` are
  `FLOAT`. Missing/invalid ratings are stored as `NULL` or `0.0`.
- `series_meta` is the single source of truth for static metadata
  (rating, genres, description, cover). A separate low-frequency
  `series_meta_sync` job refreshes it without blocking the hot path.

## Tech stack

- Python 3.11+, FastAPI + uvicorn
- psycopg2 (PostgreSQL), Redis
- httpx / curl-cffi (browser impersonation to get past Cloudflare), lxml
- pydantic-settings, ruff, pytest
- Managed with [uv](https://docs.astral.sh/uv/)

## Setup

```bash
# 1. Install uv (if not present): https://docs.astral.sh/uv/
uv sync

# 2. Create .env (see Configuration below)
cp .env.example .env   # if present

# 3. Boot (development bypasses the boot guard)
$env:ENVIRONMENT = "development"   # PowerShell
uv run uvicorn app.main:app --host 127.0.0.1 --port 3000
```

The production boot guard (`app/config.py`) refuses to start without
`CRON_SECRET`, `MONITOR_AUTH_TOKEN`, `DATABASE_URL`, and `DISCORD_BOT_TOKEN`.
Set `ENVIRONMENT=development` to bypass (never in production).

## Configuration

Config lives in `app/config.py` (loaded from `.env` via pydantic-settings).

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token (dispatches + slash commands) |
| `DATABASE_URL` | PostgreSQL transaction-pooler DSN |
| `CRON_SECRET` | Shared secret for `POST /api/cron` |
| `MONITOR_AUTH_TOKEN` | Bearer token for protected endpoints |
| `MEMBER_AUTH_TOKEN` | Write-limited member login token |
| `PUBLIC_BASE_URL` | Public base for absolute links/embeds |
| `IKIRU_BASE_URL` | ikiru site root (default `https://07.ikiru.wtf/`) |
| `SECONDARY_SOURCE_URL` | shinigami API base (default `https://api.shngm.io`) |
| `SECONDARY_PUBLIC_BASE` | shinigami public site base |
| `VORATOON_API_URL` | voratoon API base (default `https://api.voratoon.com`) |
| `VORATOON_FALLBACK_URL` | voratoon fallback (default `https://be.komikcast.cc`) |
| `RSS_LOOKBACK_HOURS` | Feed window (default `24`) |
| `REDIS_URL` | Redis queue URL (default `redis://localhost:6379/0`) |
| `ENVIRONMENT` | `production` | `development` (guard bypass) |

## Cron pipeline

Two-pass design orchestrated by an internal scheduler in `app/tasks.py`:

1. **rss-fetch pass** — `collect_recent_chapters()` scrapes
   ikiru + shinigami + voratoon, enriches metadata, and persists to
   `recent_chapters` (pruned to the 24h window). No Discord sends.
2. **enrich pass** — refreshes `series_meta` for active series.
3. **dispatch pass** — reads from `recent_chapters` (no re-scrape), filters
   whitelisted titles, and dispatches to Discord. Also auto-releases stuck
   dispatch claims (>15m) and drains the `failed_dispatches` retry queue.

`run_pipeline(dry_run=True)` computes the full dispatch (match + FCFS) without
sending or writing, for testing.

## API

| Endpoint | Description |
| --- | --- |
| `GET /healthz` | Liveness probe (`{"status":"ok"}`) |
| `GET /api/health` | Per-source status, last scrape, error rate (monitor auth) |
| `GET /api/rss` | Latest chapters; `whitelist=true` reads dispatch_history |
| `GET/POST/DELETE /api/whitelist` | Whitelist CRUD (cover/origin enriched) |
| `GET /api/catalog` | Whitelisted titles with metadata |
| `GET /api/catalog/search` | Live ikiru + shinigami + voratoon search |
| `GET /api/catalog/{title_key}/chapters` | Chapters for a title |
| `GET /api/reader/proxy` | Image proxy (CORS workaround for the reader) |
| `GET /api/dashboard-snapshot` | Materialized dashboard snapshot |
| `GET /api/sources/health` | ikiru/shinigami/voratoon health map |
| `POST /api/cron` | Cron trigger (`action=update|rss-fetch|...`, requires `CRON_SECRET`) |
| `GET /api/openapi.json` | OpenAPI schema (monitor auth) |

All endpoints return JSON; errors are normalized to
`{"error": "<code>", "message": "..."}`. No inbound rate limiting — auth is via `CRON_SECRET` / `MONITOR_AUTH_TOKEN`.

## Database

Migrations live in `app/db/migrations/` (numbered SQL files). Run in order
against the target Postgres. Key tables: `recent_chapters`, `whitelist`,
`dispatch_history`, `dispatch_claims`, `failed_dispatches`, `source_health`,
`cron_run_status`, `dashboard_snapshot`, `manga_metadata`, `excluded_titles`,
`series_meta`.

## Deployment

PM2 config is in `ecosystem.config.js` (runs `app/main.py` on port 3000 with
the project venv). Health is polled via `GET /healthz`.

Automated deploy is handled by `/root/deploy.sh` (polling `*/5m` for GitHub changes)
and `/root/deploy-webhook.py` (systemd listener on port 9876, HMAC-SHA256 verified).

## Development

```bash
uv run ruff check app          # lint (line-length 100, E/F/B/E722)
uv run ruff format --check app # formatting
uv run pytest                  # tests (testpaths=tests)
```

Run a single pipeline pass locally (fetch only):

```bash
$env:ENVIRONMENT = "development"
uv run python -c "from app.cron.pipeline import run_pipeline; print(run_pipeline(do_dispatch=False))"
```

## Notes

- ikiru serves HTML behind Cloudflare; scraping uses browser-impersonating
  requests (curl-cffi) and a jina reader fallback.
- The ikiru feed "re-touches" old chapters (renewed `<time>`) — the collector
  applies a 24h window, a monotonic chapter guard, and composite-key dedup
  (`title_key, source, chapter_num`) so old chapters never flood RSS as new.
- ikiru now operates in **gap-fill mode**: it only scans titles that are not
  already present in shinigami or voratoon. The whitelist only contains
  shinigami and voratoon entries.
- voratoon uses an early-stop pagination guard: scraping stops when the oldest
  chapter on a page is older than 24h, preventing full-history scrapes.
