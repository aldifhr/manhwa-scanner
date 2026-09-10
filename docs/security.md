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

**No inbound rate limiting.** Auth is the gate:
- `CRON_SECRET` for cron triggers
- `MONITOR_AUTH_TOKEN` for monitor endpoints
- `DASHBOARD_PASSWORD` for admin
- CORS allowlist (`app/main.py`)

## P0 security findings (from BUG.md)

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| BUG-2 | 🔴 Critical | Hardcoded default `DASHBOARD_PASSWORD="manhwascan"` + boot guard doesn't check it | Documented, unpatched |
| BUG-4 | 🔴 High | CSRF bypass: `SameSite=None` + whitelist includes `/api/v1/whitelist` and `/api/v1/cron` | Documented, unpatched |
| BUG-6 | 🔴 High | `autocommit=True` breaks `FOR UPDATE SKIP LOCKED` dispatch claims → double Discord | Documented, unpatched |
| BUG-14 | 🔴 P1 | CI `pytest \| tail` hides failures (no `pipefail`) | **FIXED** |
| BUG-15 | 🔴 P1 | CI frontend `pnpm` vs `bun` mismatch | **FIXED** |
| BUG-16 | 🔴 P1 | Auth `?token=` query string leaks in logs | **FIXED** (deprecated) |
| BUG-17 | 🔴 P1 | Audit log disabled | **FIXED** (added `audit_log` table) |
| BUG-18 | 🔴 P1 | Debug API public (exposed `BACKEND_URL`, `Set-Cookie`) | **FIXED** |

### BUG-2 detail — hardcoded password

`config.py:58` has `DASHBOARD_PASSWORD: str = "manhwascan"`. Boot guard (`config.py:138`) checks 5 secrets but **not** `DASHBOARD_PASSWORD`. If deploy forgets to set env, production is wide open with a guessable password.

**Fix:** Change default to `""` + add to boot guard, or guard against the known default value.

### BUG-4 detail — CSRF bypass

`SameSite=None` on session cookie is needed for cross-subdomain (`scanner` ↔ `komik` on `.aldifhr.fun`), but combined with CSRF whitelist including state-changing routes (`/api/v1/whitelist`, `/api/v1/cron`), cross-site requests succeed without `x-csrf-token`.

**Fix:** Remove state-changing routes from `_CSRF_WHITELIST`. FE already sends `x-csrf-token` for all mutations.

### BUG-6 detail — autocommit breaks dispatch claims

`db_adapter.py:125` sets `conn.autocommit = True` globally to fix stale snapshot reads. But `claim_recent_chapters_for_dispatch()` uses `SELECT ... FOR UPDATE SKIP LOCKED` which requires holding a transaction. With `autocommit=True`, the lock is released immediately → concurrent workers can claim the same chapter → double Discord.

**Fix:** Temporarily set `autocommit=False` within the claim transaction.

## Security recommendations

1. **Patch BUG-2 immediately** — remove hardcoded default, add to boot guard
2. **Patch BUG-4** — remove state-changing routes from CSRF whitelist
3. **Patch BUG-6** — use transaction-scoped `autocommit=False` for claim
4. Add `DASHBOARD_PASSWORD=change-me` to `.env.example`
5. Consider `SameSite=Lax` + `Origin` check instead of `SameSite=None`
6. Add rate limiting on `/api/v1/auth` login endpoint
