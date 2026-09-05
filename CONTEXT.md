# CONTEXT.md — Domain Glossary for manhwa-scanner

> Monorepo `apps/frontend` (Next 16) + `apps/backend` (FastAPI) → `openapi.json` sync, `komik` (FE) + `scanner` (BE).

## Roles — Jangan Diubah Tanpa Migrasi

- **Anon** — belum login: `localStorage` untuk `continueReading`/`readItems`/`bookmarks` (max 100), lihat `Home` `/`, `Recent` `/recent`, `Bookmarks` lokal. `GET /whitelist` public buat badge `Added`, tapi halaman `/whitelist`, `/exclude-list`, `/dispatch-history`, `/admin`, `/status` → `302 /login`.
- **Member** — `POST /api/auth?action=register` `{email,password}` → `app_users` `pbkdf2` `role=member` → `POST /api/auth?action=login` `{email,password}` → `JWT {role:member}` + `ikiru_role=member` (readable) + `httpOnly` `ikiru_dashboard_session` → `GET /bookmarks`, `GET/PUT /continue-reading` per `session_hash` (DB `chapter_bookmarks`/`continue_reading`), **tidak bisa** `POST/DELETE /whitelist`, `POST /excluded-titles`, `GET /excluded-titles`, `GET /dispatch-history` (member `401/403`, `Add WL`/`Exclude` hidden via `isAdmin` di `Navbar`/`CardActions`).
- **Admin** — `POST /api/auth?action=login` `{password: MONITOR_AUTH_TOKEN}` → `role:admin` → full: `whitelist`/`exclude`/`dispatch`/`health/refresh`/`cron`/`queue/retry` + `GET /admin` (protected dashboard: `queue`/`sources`/`errors`/`cronStatus` dari `dashboard-snapshot`). `MEMBER_AUTH_TOKEN` statik di-ignore kalau `app_users` >0 (`ponytail: drop MEMBER_AUTH_TOKEN when DB has users`).

Cookie: `ikiru_dashboard_session` `httpOnly` + `ikiru_role` readable (nav gating) + `ikiru_csrf_token` double-submit. JWT `AUTH_SECRET` HS256 7d.

## Routes — Public vs Protected

- **Public `GET` (anon):** `/`, `/recent`, `/bookmarks` (anon local), `GET /api/v1/reader/rss`, `GET /api/v1/reader/whitelist`, `GET /api/v1/whitelist` (Home), `GET /api/v1/dashboard/snapshot` + `GET /sources/health` (nav dot `Operational/Stale` tanpa `href`), `POST /api/v1/auth/*` (`login`/`register`).
- **Protected:** `GET /whitelist`, `/exclude-list`, `/dispatch-history`, `/status` (→ `302 /admin`), `/admin` → `admin` only; `GET /excluded-titles`, `GET /dispatch-history`, `GET /bookmarks` (backend) → `admin` (excluded/dispatch) atau `member+admin` (bookmarks).

## Core Concepts

- **Series / titleKey** — `normalize_title_key` (lower, alnum→space). `shinigami` UUID, `ikiru`/`voratoon` slug. PK `(title_key, source)` flat-per-source.
- **Whitelist** — `(title_key, source)` tracked. `Add WL` admin only, `GET` public.
- **Exclude** — admin only.
- **Dispatch History** — authoritative `isSent`, admin only.
- **Bookmark / ContinueReading** — `anon` `localStorage` (`bookmarks` key, `continueReading` 20), `member`/`admin` `chapter_bookmarks` per `session_hash` (`bookmark.py` single source, `continue_reading` delegates to `bookmark` — `ponytail: delegates to bookmark`).
- **Feed** — `Reader.getRssFlatPage` flat, `groupChapters` client, `isWhitelisted` source-aware.

## Deep Modules — Jangan Diutak-atik Tanpa Alasan

- **Reader** `apps/frontend/lib/reader/` — single seam `Reader.*` (pagination, snake→camel, csrf, 401). `api.ts` cuma shim.
- **Cover** `lib/cover` — `resolveCoverUrl` LRU 200, `DIRECT_HOSTS` bypass, `cover-img`→`proxy` canonical.
- **Cache** `lib/cache` — `TtlCache` factory `rss/whitelist/stats/dashboard` 10s+stale 20s `globalThis`.
- **Nav** `lib/nav.ts` `NAV` + `Navbar.tsx` `isAdmin` via `ikiru_role` cookie (httpOnly session nggak bisa `document.cookie`).
- **Group** `lib/groupChapters` — pinned + new.
- **PageShell**, **MangaCard/Cover** — shell + card seam.

## Tech — Jangan Diubah

- **DB** `app_users` (`049_create_users`), `chapter_bookmarks`, `whitelist`, `recent_chapters` (679L `ponytail: intentional`), `dispatch_claims` FCFS.
- **Auth** `app/api/auth.py` — `pbkdf2` 100k, `MEMBER_AUTH_TOKEN` drop logic, `GET /auth` me.
- **Skills** `obra/superpowers` 14 aktif per `AGENTS.md` (ponytail full) — `/.agents/skills` 14, `apps/backend/.agents` dihapus (crowded).

## Deleted Pages

- `/status` → `302 /admin` (merge), `/ab-tests`, `/audit-log`, `/graphql` — no UI.
