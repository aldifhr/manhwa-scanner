# Architecture — manhwa-scanner

> Deep technical architecture for the monorepo. For domain glossary and routes, see [CONTEXT.md](../CONTEXT.md). For backend setup, see [apps/backend/README.md](../apps/backend/README.md).

## System overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        manhwa-scanner monorepo                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  apps/frontend (Next 16, App Router, pnpm)                          │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Reader (lib/reader/)  │  Cover (lib/cover)  │  Cache         │  │
│  │  Nav (lib/nav.ts)      │  Group (lib/groupChapters)            │  │
│  └──────────────────────────────┬────────────────────────────────┘  │
│                                 │ fetch (snake→camel, csrf, 401)   │
│                                 ▼                                   │
│  apps/backend (FastAPI, uv, Python 3.11+)                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Cron scheduler (app/tasks.py)                                 │  │
│  │  ├── rss-fetch (5m):  collect ikiru+shinigami+voratoon         │  │
│  │  ├── enrich (15m):    refresh series_meta                      │  │
│  │  └── dispatch:        whitelist filter → Discord               │  │
│  │                                                               │  │
│  │  Storage: psycopg2 pool (PostgreSQL) + Redis queue             │  │
│  │  Scrapers: httpx / curl-cffi (Cloudflare bypass), lxml         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Live: komik.aldifhr.fun (FE) → scanner.aldifhr.fun (BE)           │
└─────────────────────────────────────────────────────────────────────┘
```

## Cron pipeline (two-pass)

Orchestrated by `app/tasks.py` with `ROLE=cron`:

1. **rss-fetch pass** — `collect_recent_chapters()` scrapes ikiru + shinigami + voratoon, enriches metadata, persists to `recent_chapters` (pruned to 24h window). No Discord sends.
2. **enrich pass** — refreshes `series_meta` for active series (rating, genres, description, cover).
3. **dispatch pass** — reads from `recent_chapters` (no re-scrape), filters whitelisted titles via FCFS dedup, dispatches to Discord. Auto-releases stuck dispatch claims (>15m) and drains `failed_dispatches` retry queue.

`run_pipeline(dry_run=True)` computes full dispatch without sending/writing.

## Data flow

```
collect_recent_chapters() → recent_chapters (INSERT)
    ↓
enrich_whitelist() → whitelist (UPDATE cover/rating/etc)
    ↓
build_snapshot_sync() → dashboard_snapshot (UPSERT)
    ↓
write_cron_status() → cron_run_status (INSERT)
```

```
recent_chapters (SELECT 24h)
    ↓
filter_whitelisted() → whitelist (JOIN)
    ↓
dispatch() → dispatch_history (INSERT)
    ↓
write_cron_status() → cron_run_status (INSERT)
```

## Database (12 tables — 8 core + 4 support)

| Table | Purpose | Retention | Rows |
|-------|---------|-----------|------|
| `whitelist` | Tracked series for Discord notif | Permanent | ~343 |
| `recent_chapters` | Scraped chapters (24h rolling) | 24h | ~329 |
| `dispatch_history` | Audit trail of sent chapters | 90d | ~922 |
| `cron_run_status` | Audit trail of each cron run | 90d | ~200/d |
| `dashboard_snapshot` | Materialized dashboard (singleton) | Singleton | 1 |
| `source_health` | Health per source | Permanent | 2 |
| `excluded_titles` | Titles hidden from RSS | Permanent | ~14 |
| `guild_settings` | Discord server settings | Permanent | 1 |
| `series_meta` | Static per-series metadata | Permanent | lazy |
| `continue_reading` | Per-user continue-reading | Permanent | per-user |
| `dispatch_claims` | FCFS race guard | 48h TTL | ephemeral |
| `failed_dispatches` | Retry queue for Discord failures | transient | ephemeral |

**Dropped tables (4):** `whitelist_entries`, `canonical_series`, `series_max_chapter`, `manga_metadata` — merged or made redundant.

See [apps/backend/ARCHITECTURE.md](../apps/backend/ARCHITECTURE.md) for full column-level catalog, index map (21 indexes), and migration history.

## FCFS dedup

```
fcfs_key = normalize_title(title) + "#" + normalize_chapter(chapter)
```

- `dispatch_history`: UNIQUE (chapter_url) + UNIQUE (fcfs_key)
- `dispatch_claims`: 48h TTL race guard via `FOR UPDATE SKIP LOCKED`
- `recent_chapters`: UNIQUE (title_key, source, chapter_num)

## RSS feed generation

```
recent_chapters (24h window)
    ↓
LEFT JOIN whitelist (cover, metadata)
    ↓
FILTER excluded_titles (remove hidden)
    ↓
FILTER dispatch_history (mark isSent)
    ↓
ORDER BY created_at DESC
```

## Rating system

All sources normalize ratings to a **1–10 float scale** via `app/services/rating_utils.py`. `series_meta` is the single source of truth for static metadata.

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, App Router, React 18, Tailwind, pnpm |
| Backend | Python 3.11+, FastAPI, uvicorn |
| Database | PostgreSQL (Supabase pooler), psycopg2 |
| Queue | Redis (cron queue + dead-letter) |
| Scraping | httpx, curl-cffi (Cloudflare bypass), lxml |
| Auth | JWT (HS256), single admin password |
| Validation | Pydantic-settings, ruff, pytest |
| Deploy | PM2, Caddy, Vercel (frontend) |
