# Svelte Migration Design — Next.js → SvelteKit (Full Native)

**Date:** 2026-09-08
**Scope:** `apps/frontend` (Next 16 + React 19, 55 routes, 33 lib, 58 components) → `apps/frontend-svelte` (SvelteKit 2 + Svelte 5) parallel (option B), 100% parity.
**Related Plan:** `docs/superpowers/plans/2026-09-08-svelte-migration.md` (to be created via writing-plans)

## 1. Goal

Replace frontend framework with zero feature loss, keep FastAPI backend contract (`scanner.aldifhr.fun`) and auth model (single `DASHBOARD_PASSWORD` JWT `ikiru_dashboard_session` + readable `ikiru_csrf_token` twin). New app coexists alongside old `apps/frontend` until swap. Deployment target Vercel (`adapter-vercel`), domain flexible.

## 2. Architecture

### 2.1 Monorepo Layout

- Keep `apps/frontend` frozen (no changes except workspace config).
- New `apps/frontend-svelte`:

```
apps/frontend-svelte/
  svelte.config.js        # adapter-vercel, alias $lib → src/lib, $components → src/components
  vite.config.ts          # vite + vitest + @testing-library/svelte, svelte plugin
  tsconfig.json           # strict, bundler, paths $lib/*, $components/*
  tailwind.config? / app.css (globals.css+gold.css merged, Tailwind 4)
  static/                 # public assets (icon.svg, manifest.json, sw.js, cn/jp/kr.png)
  src/
    app.css
    app.html
    hooks.server.ts       # auth + CSP (replaces middleware.ts)
    lib/                  # ported from apps/frontend/lib (see 2.3)
    components/           # .svelte ports (see 2.4)
    routes/
      +layout.svelte / +layout.server.ts / +error.svelte
      +page.svelte (+page.ts)  # /
      recent/ whitelist/ exclude-list/ dispatch-history/ bookmarks/ admin/ cron/ error-logs/ login/ register/ about/ debug/
      api/v1/**/+server.ts, api/cron/**, api/public/**, api/fastcron/**, api/openapi.json/**
```

### 2.2 Workspace & Build

- `pnpm-workspace.yaml` add `apps/frontend-svelte`.
- Root `package.json` scripts:
  - `dev:frontend:svelte: pnpm --filter manhwa-svelte dev`
  - keep `dev:frontend` pointing to Next for now; `dev` stays Next until swap.
- `apps/frontend-svelte/package.json` name `manhwa-svelte`, scripts `dev: vite dev`, `build: vite build`, `preview`, `typecheck: svelte-check`, `test: vitest run`.
- `vercel.json` stays `framework: nextjs` while parallel; on swap change to `sveltekit` + `buildCommand: pnpm --filter manhwa-svelte build`. No rewrites in vercel.json; proxy via SvelteKit server routes.

### 2.3 Lib Ports (33 files)

Reuse verbatim where framework-agnostic, adapt where React/Next-specific:

- **Keep as-is (copy):** `types.ts`, `constants.ts`, `timeAgo.ts`, `styles.ts`, `groupChapters.ts`, `feed.ts`, `schemas.ts`, `fetchError.ts`, `cover/*`, `security/headers.ts`, `server/whitelist.ts`, `cache/*`, `image-cache.ts`, `continueReading/*`, `auth.ts` (verifyToken), `csrf.ts`, `utils.ts` (cn helper)
- **Adapt:** `reader/transport.ts` (use `event.fetch` vs global fetch, forward cookies), `reader/index.ts`, `reader/mapper.ts`, `server-api.ts`, `api.ts` (bookmarks seam keep localStorage vs backend, same `ikiru_csrf_token` check), `queryKeys.ts`/`staleTimes` → keep constants but consumed by `load` not react-query, `nav.ts` (icons switch to svelte), `uiStore.ts` (zustand → `uiStore.svelte.ts` with `$state`), hooks `use*` → svelte stores/composables (`useDebounced`, `useToast`, `useRefreshAll`, `usePacerThrottles`, `useUiUrlSync`, `useWebSocket`, `useScrollVisibility`, `useLongPress`)
- **Delete:** `QueryProvider` concept, React-specific providers.

### 2.4 Components (58 files)

- `Navbar.tsx` + `Nav/*` → `Navbar.svelte` + `Nav/` svelte
- `PageShell`, `EmptyState`, `ErrorFallback`, `ErrorBoundary`, `SkeletonGrid`, `ScrollProgress`, `Announcement`, `BackToTop`, `MangaCard`, `WhitelistGrid/Card`, `DispatchHistoryClient`, `ContinueReadingStrip`, `StatsCharts`
- `components/ui/*` (Button, Card, Badge, Alert, Modal, Select, SearchInput, GenreChips, Cover, etc.) → `.svelte` with `$props()` + `cn()` + tailwind
- `components/home/*` (AllTab, AllCard, GroupedSeriesCard, VirtualizedList, InfiniteSentinel, FilterDrawer, etc.) → svelte ports; `VirtualizedList` uses `svelte:window` + `{#each}` or `svelte-virtual` lightweight; `framer-motion` → `svelte/motion` + `transition:fly/slide`
- Icons: `@phosphor-icons/react` → `@phosphor-icons/svelte` (same API) or `lucide-svelte`; keep `geist` font via `app.html`/`+layout.svelte`.

### 2.5 Routing & API

- File-based routing maps 1:1 from `app/`:
  - `app/layout.tsx` → `src/routes/+layout.svelte` (html shell, Geist font, `Navbar`, `Announcement`, `ToastProvider`)
  - Each `app/**/page.tsx` → `src/routes/**/ +page.svelte` (+ `+page.ts` or `+page.server.ts` for data)
  - `app/not-found.tsx` → `src/routes/+error.svelte` handling 404
  - `app/loading.tsx` / `error.tsx` → `+page.svelte` `{#await}` + `+error.svelte`
- API: each `app/api/**/route.ts` → `src/routes/api/**/ +server.ts` exporting `GET/POST/DELETE` etc.
  - Proxy logic same: `fetch("https://scanner.aldifhr.fun"+path, { headers: forward cookies/auth, method })`
  - Return `json` with same `Cache-Control`/`Content-Type` headers as `next.config.ts` headers() did.
  - Next rewrites (`/api/reader/:path*` → `/api/v1/reader/:path*`, etc.) reproduced as SvelteKit server route aliases or handled in `+server.ts` fallback; also add redirect map in `hooks.server.ts` if needed.

### 2.6 Auth & Middleware

- `middleware.ts` → `src/hooks.server.ts:handle`
  - `PUBLIC_EXACT` (/, /recent, /bookmarks, /about, /login, /sw.js, etc.) + `PUBLIC_PREFIX` + `PUBLIC_GET_PREFIX` identical lists.
  - On public path → `applySecurityHeaders(event)` then `resolve(event)`
  - Else check `cookies.get(COOKIE_NAME)` + `verifyToken(token)` (from `lib/auth.ts`); if missing/invalid → for `/api/*` return `json({success:false,error:"unauthorized"},401)` with CSP headers, else redirect `302 /login?redirect=pathname`
  - Always set `Content-Security-Policy` (`getCsp(isDev)`) + `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` via `getSecurityHeaders()`
- `svelte.config.js` no Next headers; all via hooks.

## 3. Data Flow

- **Server load:** `+layout.server.ts` loads `locals.user` (from hooks), `+page.server.ts` for initial whitelist/dashboard snapshot via `server-api.ts`/`Reader.getDashboardSnapshot()` using `event.fetch`.
- **Client load:** `+page.ts` uses `fetch("/api/v1/reader/rss?limit=36&group=false")` then `groupChapters(results)` (same as Next Home). `recent/+page.ts` infinite pagination via `?page=&pageSize=`.
- **Stores:** `uiStore.svelte.ts` exposes `$state` for filters/pagination; `continueReading` store persists to `localStorage` (same keys), `bookmarks` seam same (check `document.cookie` for `ikiru_csrf_token` to decide anon vs backend).
- **Caching:** SvelteKit `load` cache via `depends`/`invalidate`; manual `staleTimes` respected via `fetch` cache headers; no react-query.

## 4. Error Handling

- `+error.svelte` renders `ErrorFallback` equivalent (title/message/retry `invalidateAll()`).
- API `+server.ts` catch proxy errors → `json({success:false,error: message}, status)` forwarding backend status.
- CSP violations logged same as Next.
- Zod validation in `+server.ts` for POST bodies (`lib/schemas.ts`).

## 5. Testing & Verification

- **Typecheck:** `svelte-check --tsconfig ./tsconfig.json`
- **Unit/Component:** `vitest` + `jsdom` + `@testing-library/svelte`, port `tests/*.test.ts(x)` (schemas, constants, nav, api, components, interactions, routes). New tests mirror existing assertions.
- **Build:** `pnpm --filter manhwa-svelte build` must succeed.
- **Manual verify:** `pnpm --filter manhwa-svelte dev` → `curl http://localhost:5173/api/v1/reader/rss` matches Next output; nav auth redirect matches; CSP headers present; `bookmarks` anon vs authed flow.

## 6. Non-Goals

- No backend changes.
- No design system overhaul (keep Tailwind, gold.css, geists).
- No domain hardcoding (adapter-vercel, env `PUBLIC_API_BASE` if needed, default `scanner.aldifhr.fun`).

## 7. Risks & Mitigations

- **VirtualizedList performance:** Use native `{#each}` + `InfiniteSentinel` first; fallback to `svelte-virtual` if >1k items lag.
- **Icon mismatch:** `@phosphor-icons/svelte` may have different imports; wrap in `lib/icons.ts` shim.
- **Cover proxy CSP:** Ensure `hooks.server.ts` sets `Content-Type: image/webp` for `/api/v1/reader/cover` same as next headers.
- **JWT httpOnly twin:** Same `ikiru_csrf_token` readable check must stay in `lib/api.ts`.

## 8. Decisions Logged

- Option B parallel (not in-place) per user 2026-09-08.
- Full parity per user.
- Native SvelteKit load/fetch (no tanstack) per user "full svelte" + ponytail.

## Self-Review Checklist

- [x] No TBD/TODO placeholders
- [x] Architecture matches routes/components/lib counts (55/33/58)
- [x] Auth/CSP lists copied verbatim from middleware.ts + next.config.ts
- [x] Single implementation plan scope (one new app), not multi-project decomposition needed
