# manhwa-scanner — Monorepo

Next.js Frontend + FastAPI Backend — `openapi.json` synced, `komik.aldifhr.fun` (FE) → `scanner.aldifhr.fun` (BE).

- **FE** `apps/frontend` — Next 16 App Router, `pnpm --filter manhwa-reader dev` (`http://localhost:3000`)
- **BE** `apps/backend` — FastAPI, `uv run uvicorn app.main:app --reload` (`http://localhost:8000`)
- **Live:** `https://komik.aldifhr.fun` → `https://scanner.aldifhr.fun`

## Roles — Full Admin Only (single password `DASHBOARD_PASSWORD`)

| Role   | Login                                                                               | Bisa                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anon` | —                                                                                   | Lihat `Home` `/`, `Recent` `/recent`, `Bookmarks` (localStorage), `Operational` dot di nav                                                                    |
| `admin`| `POST /api/v1/auth?action=login` `{password: DASHBOARD_PASSWORD}` → `ikiru_dashboard_session` (JWT) | `anon` + `bookmark`/`continueReading` sync DB `chapter_bookmarks` per `session_hash` + `add/remove whitelist`, `exclude`, `dispatch`/`send notif`, `GET /admin`, `/whitelist`, `/exclude-list`, `/dispatch-history` |

Semua endpoint mutasi (`POST/DELETE /whitelist`, `POST /excluded-titles`, `POST /api/cron`) butuh `ikiru_dashboard_session` (admin). Tanpa login → `401` / `302 /login`.

## Routes

- Public `GET`: `/`, `/recent`, `/bookmarks` (anon local), `GET /api/v1/reader/rss`, `/api/v1/dashboard/snapshot` (`Operational` dot), `GET /whitelist` (Home badge)
- Protected `GET`: `/whitelist`, `/exclude-list`, `/dispatch-history`, `/admin`, `/status` → butuh login (`302 /login`)
- Mutating: `POST /whitelist`, `POST /excluded-titles` → butuh login (`401` kalau anon)

## Dev

```bash
pnpm install
pnpm --filter manhwa-reader dev        # FE
cd apps/backend && uv run uvicorn app.main:app --reload  # BE
pnpm --filter manhwa-reader typecheck && pnpm --filter manhwa-reader test
```

## Env

| Variable                               | Contoh          | Ket                                           |
| -------------------------------------- | --------------- | --------------------------------------------- |
| `DASHBOARD_PASSWORD` / `MONITOR_AUTH_TOKEN` | `BE .env`       | admin password (single, `DASHBOARD_PASSWORD` utama) |
| `AUTH_SECRET`                          | `BE .env`       | HS256 JWT `ikiru_dashboard_session`                 |
| `DATABASE_URL`                         | Supabase pooler | `chapter_bookmarks`, `whitelist`, `recent_chapters` |

`app_users` di-drop `050` — full admin only, tidak pakai `pbkdf2`/`role` lagi.

## Docs

- `CONTEXT.md` — domain & deep modules (`Reader`, `Cover`, `Cache`)
- `AGENTS.md` — 14 skills `obra/superpowers` (ponytail full)
- `apps/backend/openapi.json` — contract
