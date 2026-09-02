# CONTEXT.md — Domain Glossary for manhwa-scanner (Monorepo)

Bahasa domain untuk sebut seam yang bagus. Dipakai oleh `/improve-codebase-architecture` dan `/codebase-design`.

> Monorepo 1 repo 1 codebase: `apps/frontend` (Next.js 15 + TS) + `apps/backend` (Python FastAPI) — sinkron via `openapi.json`.

## Monorepo Structure

- **apps/frontend** — Next.js App Router, `pnpm --filter manhwa-reader dev` (`next dev` tanpa build). Semua UI & proxy `/api/v1/*` ke backend.
- **apps/backend** — Python FastAPI, `uv run uvicorn app.main:app --reload` (port 8000). Scraper shinigami/ikiru/voratoon, dispatch pipeline, Supabase.
- **packages/shared** — (rencana) contract `openapi.json` → generate zod + TS types, single source truth FE↔BE.
- **Root** — `pnpm-workspace.yaml` `packages: ["apps/*","packages/*"]`, `pnpm-lock.yaml` tunggal di root, `pnpm approve-builds --all` untuk tree-sitter.

## Core Concepts

- **Manga / Series** — judul unik (titleKey). Satu Series bisa punya banyak Chapter dari sumber berbeda (shinigami, ikiru). Canonical key via fuzzy slug.
- **Chapter** — rilis per chapter_number + chapterLabel, di-feed RSS flat atau dispatch history.
- **Source** — asal scraper: `shinigami`, `ikiru`, `voratoon`. Punya health (successesToday/failuresToday, status healthy/degraded).
- **Whitelist** — daftar Series yang di-track untuk notifikasi. Entry punya title, source, cover, origin, type, rating. Composite PK `(title_key, source)`.
- **Exclude List** — daftar titleKey yang disembunyikan dari RSS + notifikasi, per source (all/ikiru/shinigami). Normalisasi `’`→`'` untuk delete.
- **Dispatch History** — log authoritative chapter yang benar-benar terkirim (bukan 24h feed). Source of truth untuk `isSent`.
- **Feed (RSS Flat)** — feed agregat chapter terbaru, paginated, bisa filter source/type/whitelist, `group=false`. Cache 10s + stale-while-revalidate.
- **Queue / Cron** — cron scraper (FastCron) + retry queue, depth, outcome, duration, sent/matched. Lock file + `disabled_until` per source.
- **Origin / Type** — origin KR/CN/JP, type manhwa/manhua/manga, dinormalisasi via `normalizeOrigin`.
- **Continue Reading** — sync lintas device via `PUT /api/v1/continue-reading` (localStorage + BE), max 20, dedup per titleKey.

## Backend Concepts (apps/backend)

- **Collect / Enrich / Dispatch** — pipeline terpisah (`app/pipeline/`): collect RSS 24h paginated, enrich cover/origin/rating, dispatch ke Discord.
- **Source Health** — `source_health` table, auto-cooldown 30m jika `consecutive_failures>=3`.
- **Failed Dispatches** — retry targeted per chapter, bukan full pipeline.
- **API v1** — semua endpoint di `/api/v1/*` (auth via `ikiru_dashboard_session` cookie + `x-csrf-token`, fallback `API_TOKEN`).

## UI Modules (Deep Module Names)

- **PageShell** — deep module untuk layout shell halaman: max-w, padding, safe-area, pb untuk bottom-nav, slot fallback/error. Satu seam untuk semua page.
- **MangaCard / Cover** — card untuk Series/Chapter di Home/Recent/Whitelist, dengan Cover image, Source pill, Chapter badge. Co-located `MangaCard.Skeleton`.
- **Reader** — deep module di `apps/frontend/lib/reader/` yang sembunyikan pagination, snake→camel mapping, csrf, 401 handling untuk semua fetch whitelist/history/rss. Single seam `Reader.*`.
- **Nav** — deep module navigasi: presentational NavItem + adapters Auth (logout) & Prefetch (queryClient). `NAV` di `apps/frontend/lib/nav.ts` single source.
- **Group** — pengelompokan chapter per titleKey (groupChapters), dengan pinned & new-24h badge.
- **NavbarStatus** — dot health (operational/degraded/stale) dari `dashboardSnapshot`, link ke `/health` (bukan `/status` lagi).

## Deleted Pages (Monorepo Cleanup 2026-09-02)

- `/status`, `/ab-tests`, `/audit-log`, `/graphql` — dihapus (page + NAV). API proxy tetap ada jika dibutuhkan, tapi tidak ada UI.
