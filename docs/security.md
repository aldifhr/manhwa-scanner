# Security — manhwa-scanner

> Security model, auth flow, and known findings. For full bug details, see [BUG.md](../BUG.md).

## Auth model

**Single admin password** (`DASHBOARD_PASSWORD`) — full admin, no roles.

```
POST /api/v1/auth?action=login {password: DASHBOARD_PASSWORD}
    → 200 + set-cookie: ikiru_dashboard_session (JWT, httpOnly, 7d)
              set-cookie: ikiru_csrf_token (readable, 7d)
```

| Cookie | Flags | Purpose |
|--------|-------|---------|
| `ikiru_dashboard_session` | `httpOnly`, `Secure`, `SameSite=None`, `domain=.aldifhr.fun` | JWT (HS256, `AUTH_SECRET`) |
| `ikiru_csrf_token` | `Secure`, `SameSite=None`, `domain=.aldifhr.fun` | CSRF double-submit token |

**Auth levels:**
- `anon` — no cookie → public routes only
- `admin` — valid JWT cookie → full access
- `cron` — `CRON_SECRET` or `Authorization: Bearer` → `POST /api/cron`
- `monitor` — `MONITOR_AUTH_TOKEN` or `Authorization: Bearer` → health endpoints

## CSRF protection

`app/middleware/csrf.py` enforces double-submit token pattern:

- Whitelisted paths (no CSRF check): `/api/v1/auth`, `/api/v1/interactive`
- All other mutating routes require `x-csrf-token` header == `ikiru_csrf_token` cookie
- `Bearer` auth bypasses CSRF (API-to-API)

Frontend sends `x-csrf-token` via `withCsrf()` in `lib/csrf.ts` + `reader/transport.ts`.

## JWT details

- Algorithm: HS256
- Secret: `AUTH_SECRET` (from `.env`)
- Session cookie: 7 days
- Refresh: `POST /api/v1/auth?action=refresh`

## Rate limiting

None — auth is via `CRON_SECRET` / `MONITOR_AUTH_TOKEN`, not rate limiting.

## P0 security findings (from BUG.md)

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| BUG-2 | 🔴 Critical | Hardcoded default `DASHBOARD_PASSWORD="manhwascan"` + boot guard doesn't check it | **FIXED** — `config.py:76` default `""` + `_validate_settings:205` enforces in production |
| BUG-4 | 🔴 High | CSRF bypass: `SameSite=None` + whitelist includes `/api/v1/whitelist` and `/api/v1/cron` | **FIXED** — `app/middleware/csrf.py:5` whitelist now only `{auth,interactive}`; `/whitelist` and `/cron` require `x-csrf-token` or `Bearer` |
| BUG-6 | 🔴 High | `autocommit=True` breaks `FOR UPDATE SKIP LOCKED` dispatch claims → double Discord | **FIXED** — `app/services/claim.py:84` `conn.autocommit=False` + `conn.commit()` + same pattern in `app/storage/dispatch.py:269` |
| BUG-14 | 🔴 P1 | CI `pytest \| tail` hides failures (no `pipefail`) | **FIXED** |
| BUG-15 | 🔴 P1 | CI frontend `pnpm` vs `bun` mismatch | **FIXED** |
| BUG-16 | 🔴 P1 | Auth `?token=` query string leaks in logs | **FIXED** (deprecated) |
| BUG-17 | 🔴 P1 | Audit log disabled | **FIXED** (added `audit_log` table) |
| BUG-18 | 🔴 P1 | Debug API public (exposed `BACKEND_URL`, `Set-Cookie`) | **FIXED** |

### BUG-2 detail — hardcoded password — FIXED

Was `config.py:76` `DASHBOARD_PASSWORD="manhwascan"` with boot guard not checking it. Now default `""` and `_validate_settings:205` raises `BOOT GUARD: ... DASHBOARD_PASSWORD` in production if missing. Fix verified.

### BUG-4 detail — CSRF bypass — FIXED

Was `SameSite=None` + `_CSRF_WHITELIST` including `/whitelist` and `/cron`. Now `app/middleware/csrf.py:5` only whitelists `{auth,interactive}`. `/cron` and `/whitelist` require `x-csrf-token == ikiru_csrf_token` or `Authorization: Bearer`. FE `withCsrf()` already sends it; state-changing cross-site without token now `403`.

### BUG-6 detail — autocommit breaks dispatch claims — FIXED

Was `db_adapter.py:get_conn` `autocommit=True` releasing `FOR UPDATE SKIP LOCKED` immediately. Now `app/services/claim.py:84` sets `conn.autocommit=False`, holds lock across `SELECT ... FOR UPDATE SKIP LOCKED` + `INSERT dispatch_claims ... ON CONFLICT DO NOTHING` + `conn.commit()`, with `rollback` on error and `put_conn` in `finally`. Same transactional pattern applied in `app/storage/dispatch.py:269`.

## Security recommendations

1. ~~Patch BUG-2/4/6~~ — done (see above)
2. Keep `DASHBOARD_PASSWORD` documented in `.env.example` as `change-me` for production
3. Consider `SameSite=Lax` + `Origin` check if cross-subdomain `scanner↔komik` no longer needs `None`
