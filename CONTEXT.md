# CONTEXT.md — Domain Glossary for manhwa-scanner

> Monorepo `apps/frontend` (Next 16) + `apps/backend` (FastAPI) → `openapi.json` sync, `komik` (FE) + `scanner` (BE).

## Roles — Full Admin Only (single password `DASHBOARD_PASSWORD`)

- **Anon** — belum login: `localStorage` untuk `continueReading`/`readItems`/`bookmarks` (max 100), lihat `Home` `/`, `Recent` `/recent`, `Bookmarks` lokal. `GET /whitelist` public buat badge `Added`, tapi halaman `/whitelist`, `/exclude-list`, `/dispatch-history`, `/admin`, `/status` → `302 /login`.
- **Admin** — `POST /api/v1/auth?action=login` `{password: DASHBOARD_PASSWORD}` → `ikiru_dashboard_session` `httpOnly` + `ikiru_csrf_token` readable (nav gating `Navbar.tsx:21` cek `csrf`) → full: `whitelist`/`exclude`/`dispatch`/`health/refresh`/`cron`/`queue/retry` + `GET /admin` + `GET/POST /bookmarks` & `continue-reading` per `session_hash` (DB `chapter_bookmarks`).

Cookie: `ikiru_dashboard_session` `httpOnly` + `ikiru_csrf_token` readable (7d, `AUTH_SECRET` HS256). Tidak ada `ikiru_role`/`app_users`/`member` lagi.

## Routes — Public vs Protected

- **Public `GET` (anon):** `/`, `/recent`, `/bookmarks` (anon local), `GET /api/v1/reader/rss`, `GET /api/v1/reader/whitelist`, `GET /api/v1/whitelist` (Home), `GET /api/v1/dashboard/snapshot` + `GET /sources/health` (nav dot `Operational/Stale` tanpa `href`), `POST /api/v1/auth?action=login`.
- **Protected:** `GET /whitelist`, `/exclude-list`, `/dispatch-history`, `/status` (→ `302 /login`), `/admin` → butuh login; `GET /excluded-titles`, `GET /dispatch-history`, `GET /bookmarks` (backend) → butuh login (dulu `admin` vs `member`, sekarang full admin).

## Core Concepts

- **Series / titleKey** — `normalize_title_key` (lower, alnum→space). `shinigami` UUID, `ikiru`/`voratoon` slug. PK `(title_key, source)` flat-per-source.
- **Whitelist** — `(title_key, source)` tracked. `Add WL` admin only, `GET` public.
- **Exclude** — admin only.
- **Dispatch History** — authoritative `isSent`, admin only.
- **Bookmark / ContinueReading** — `anon` `localStorage` (`bookmarks` key, `continueReading` 20), `login` → `chapter_bookmarks` per `session_hash` (`bookmark.py` single source, `continue_reading` delegates to `bookmark` — `ponytail: delegates to bookmark`).
- **Feed** — `Reader.getRssFlatPage` flat, `groupChapters` client, `isWhitelisted` source-aware.

## Deep Modules — Jangan Diutak-atik Tanpa Alasan

- **Reader** `apps/frontend/lib/reader/` — single seam `Reader.*` (pagination, snake→camel, csrf, 401). `api.ts` cuma shim.
- **Cover** `lib/cover` — `resolveCoverUrl` LRU 200, `DIRECT_HOSTS` bypass, `cover-img`→`proxy` canonical.
- **Cache** `lib/cache` — `TtlCache` factory `rss/whitelist/stats/dashboard` 10s+stale 20s `globalThis`.
- **Nav** `lib/nav.ts` `NAV` + `Navbar.tsx` `isLoggedIn` via `ikiru_csrf_token` readable (session `httpOnly` tidak terlihat di JS).
- **Group** `lib/groupChapters` — pinned + new.
- **PageShell**, **MangaCard/Cover** — shell + card seam.

## Tech — Jangan Diubah

- **DB** `chapter_bookmarks`, `whitelist`, `recent_chapters` (679L `ponytail: intentional`), `dispatch_claims` FCFS (`app_users` dropped `050`).
- **Auth** `app/api/auth.py` — single password `DASHBOARD_PASSWORD` (`hmac.compare_digest`), `GET /auth` me, `POST /auth` login/refresh.
- **Skills** `obra/superpowers` 14 aktif per `AGENTS.md` (ponytail full) — `/.agents/skills` 14, `apps/backend/.agents` dihapus (crowded).

## Deleted Pages

- `/status` → `302 /admin` (merge), `/ab-tests`, `/audit-log`, `/graphql` — no UI.
