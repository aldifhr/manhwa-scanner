# manhwa-scanner — Monorepo

Next.js Frontend + FastAPI Backend — `openapi.json` synced, `komik.aldifhr.fun` (FE) → `scanner.aldifhr.fun` (BE).

- **FE** `apps/frontend` — Next 16 App Router, `pnpm --filter manhwa-reader dev` (`http://localhost:3000`)
- **BE** `apps/backend` — FastAPI, `uv run uvicorn app.main:app --reload` (`http://localhost:8000`)
- **Live:** `https://komik.aldifhr.fun` → `https://scanner.aldifhr.fun`

## Roles

| Role     | Login                                                                                                                        | Bisa                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anon`   | —                                                                                                                            | Lihat `Home` `/`, `Recent` `/recent`, `Bookmarks` (localStorage), `Operational` dot di nav                                                                               |
| `member` | `POST /api/auth?action=register` `{email,password}` → `POST /api/auth?action=login` `{email,password}` → `ikiru_role=member` | `anon` + `bookmark` per login (`chapter_bookmarks` per `session_hash`), `continueReading` sync `bookmark`                                                                |
| `admin`  | `POST /api/auth?action=login` `{password: MONITOR_AUTH_TOKEN}` → `role:admin`                                                | `member` + `add/remove whitelist`, `exclude`, `dispatch`/`send notif`, `GET /admin`, `/status` (redirect → `/admin`), `/whitelist`, `/exclude-list`, `/dispatch-history` |

`GET` whitelist/dispatch/exclude → `admin` only (member `401`), `POST/DELETE` whitelist/exclude → `admin` only. `member` cuma `bookmark`.

## Routes

- Public `GET`: `/`, `/recent`, `/bookmarks` (anon local), `GET /api/v1/reader/rss`, `/api/v1/dashboard/snapshot` (`Operational` dot), `GET /whitelist` (Home badge)
- Protected `GET`: `/whitelist`, `/exclude-list`, `/dispatch-history`, `/admin`, `/status` → `admin` (member `302 /login`)
- Mutating: `POST /whitelist`, `POST /excluded-titles` → `admin` (`403` buat member)

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
| `MONITOR_AUTH_TOKEN`                   | `BE .env`       | admin password                                |
| `MEMBER_AUTH_TOKEN`                    | `BE .env`       | seed member (di-ignore kalau `app_users` >0)  |
| `AUTH_SECRET`                          | `BE .env`       | HS256 JWT `ikiru_dashboard_session`           |
| `DATABASE_URL`                         | Supabase pooler | `app_users`, `chapter_bookmarks`, `whitelist` |
| `NEXT_PUBLIC_API_BASE` / `BACKEND_URL` | `FE .env.local` | `https://scanner.aldifhr.fun`                 |

`app_users` (`049_create_users`) — `email` unique, `password_hash` `pbkdf2`, `role` `member`.

## Docs

- `CONTEXT.md` — domain & deep modules (`Reader`, `Cover`, `Cache`)
- `AGENTS.md` — 14 skills `obra/superpowers` (ponytail full)
- `apps/backend/openapi.json` — contract
