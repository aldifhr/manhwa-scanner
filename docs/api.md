# API Endpoints — manhwa-scanner

> Endpoint overview. Full schema with request/response types: [`apps/backend/openapi.json`](../apps/backend/openapi.json) (1363 lines, OpenAPI 3.1.0).

## Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/auth?action=login` | — | Login with `DASHBOARD_PASSWORD` → `ikiru_dashboard_session` JWT |
| `GET` | `/api/v1/auth` | cookie | Current session info |
| `POST` | `/api/v1/auth?action=refresh` | cookie | Refresh JWT |

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/healthz` | — | Liveness probe |
| `GET` | `/api/health` | monitor | Per-source status, error rate |
| `GET` | `/api/sources/health` | — | ikiru/shinigami/voratoon health map |

## Reader / RSS

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/reader/rss` | — | Latest chapters (24h, flat) |
| `GET` | `/api/v1/reader/whitelist` | — | Whitelist (reader compat) |
| `GET` | `/api/v1/reader/proxy` | — | Image proxy (CORS workaround) |

## Whitelist

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/whitelist` | — | Whitelisted titles (public for badge) |
| `POST` | `/api/v1/whitelist` | admin | Add to whitelist |
| `DELETE` | `/api/v1/whitelist` | admin | Remove from whitelist |
| `PATCH` | `/api/v1/whitelist` | admin | Update whitelist entry |

## Exclude

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/excluded-titles` | admin | List excluded titles |
| `POST` | `/api/v1/excluded-titles` | admin | Exclude a title (per-source) |
| `POST` | `/api/v1/excluded-titles/bulk` | admin | Bulk exclude |
| `DELETE` | `/api/v1/excluded-titles` | admin | Remove exclusion |

## Catalog

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/catalog` | — | Whitelisted titles with metadata |
| `GET` | `/api/v1/catalog/search` | — | Live search across all sources |
| `GET` | `/api/v1/catalog/{title_key}/chapters` | — | Chapters for a title |

## Dashboard

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/dashboard/snapshot` | — | Materialized dashboard payload |
| `GET` | `/api/v1/dashboard/stats` | — | Dashboard statistics |

## Dispatch

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/dispatch-history` | admin | Audit trail of sent chapters |
| `POST` | `/api/v1/failed-dispatches?action=retry` | admin | Retry failed Discord sends |

## Bookmarks / Continue Reading

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/bookmarks` | admin | Synced bookmarks (DB) |
| `POST` | `/api/v1/bookmarks` | admin | Add bookmark |
| `GET` | `/api/v1/continue-reading` | admin | Continue-reading entries |
| `POST` | `/api/v1/continue-reading` | admin | Update continue-reading |

## Cron / Queue

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/cron` | cron | Trigger cron action (`update`, `rss-fetch`, `enrich`) |
| `GET` | `/api/v1/queue/cron` | admin | List cron queue depth |
| `DELETE` | `/api/v1/queue/cron` | admin | Clear cron queue |
| `GET` | `/api/v1/queue/status` | — | Queue health (depth, processing) |

## Auth levels

| Level | How | Access |
|-------|-----|--------|
| `anon` | — | Public GET routes, localStorage bookmarks |
| `admin` | `ikiru_dashboard_session` cookie (JWT) | All mutating routes, sync DB, admin pages |
| `cron` | `CRON_SECRET` or `Authorization: Bearer` | `POST /api/cron` |
| `monitor` | `MONITOR_AUTH_TOKEN` or `Authorization: Bearer` | Health endpoints, openapi.json |

## Error format

All errors normalize to:

```json
{"error": "<code>", "message": "..."}
```

Common codes: `401` (unauthorized), `403` (forbidden), `422` (validation_error), `500` (internal).
