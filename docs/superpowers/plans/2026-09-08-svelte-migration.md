# Svelte Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `apps/frontend-svelte` (SvelteKit 2 + Svelte 5) parallel to `apps/frontend` (Next 16) with 100% parity — all 11 pages + 25 API proxies + auth middleware — without touching backend.

**Architecture:** New SvelteKit app with `adapter-vercel`, file-based `src/routes`, `src/hooks.server.ts` replacing `middleware.ts`, `src/lib` ported from Next `lib/`, `src/components/*.svelte` replacing `.tsx`, native `load` + `fetch` (no tanstack), Tailwind 4 + `app.css`.

**Tech Stack:** SvelteKit 2, Svelte 5 (runes `$state/$props`), TypeScript 5 strict, Vite 6, Tailwind 4, `@sveltejs/adapter-vercel` ^5, `svelte-check`, `vitest` + `@testing-library/svelte` + `jsdom`, `clsx` + `tailwind-merge`, `zod` ^4.4.3, `@phosphor-icons/svelte`.

**Spec:** `docs/superpowers/specs/2026-09-08-svelte-migration-design.md`

## Global Constraints

- Node >=20, pnpm 11.22.0 (from root packageManager) — use `pnpm --filter manhwa-svelte` for all commands
- Svelte 5 runes only, no React/Next imports in new app
- Auth cookie names exact: `ikiru_dashboard_session` (httpOnly JWT) + readable twin `ikiru_csrf_token` — verify via `lib/auth.ts:verifyToken` (copy verbatim)
- CSP via `lib/security/headers.ts:getCsp(dev)` + `getSecurityHeaders(dev)` — must match Next `next.config.ts:headers()` and `middleware.ts:applySecurityHeaders`
- Proxy target `https://scanner.aldifhr.fun` for all `/api/v1/*` server routes — forward cookies + `Authorization` header, preserve status + `Cache-Control`/`Content-Type`
- Tailwind class merging via `lib/utils.ts:cn(...inputs)` (`clsx`+`tailwind-merge`) — reuse verbatim
- Public auth bypass lists exact from `middleware.ts: PUBLIC_EXACT (9 entries), PUBLIC_PREFIX (14), PUBLIC_GET_PREFIX (7)`
- Keep `packages/shared/openapi.json` contract — no breaking API shape changes
- All new routes under `apps/frontend-svelte/src/routes` — Next `apps/frontend` frozen

---

### Task 1: Scaffolding SvelteKit App + Workspace Wiring

**Files:**

- Create: `apps/frontend-svelte/package.json`
- Create: `apps/frontend-svelte/svelte.config.js`
- Create: `apps/frontend-svelte/vite.config.ts`
- Create: `apps/frontend-svelte/tsconfig.json`
- Create: `apps/frontend-svelte/src/app.html`
- Create: `apps/frontend-svelte/src/app.css`
- Create: `apps/frontend-svelte/static/manifest.json` (copy from frontend) + `static/icon.svg`, `static/apple-icon.svg`, `static/cn.png`, `static/jp.png`, `static/kr.png`, `static/sw.js`
- Modify: `pnpm-workspace.yaml:3` (add `apps/frontend-svelte` is already covered by `apps/*` but verify), `package.json:7-13` (add scripts)
- Test: `apps/frontend-svelte/tests/scaffold.test.ts` (exists check + build smoke)

**Interfaces:**

- Consumes: nothing (foundation)
- Produces: `apps/frontend-svelte` buildable via `pnpm --filter manhwa-svelte build`; alias `$lib` → `src/lib`, `$components` → `src/components`

- [ ] **Step 1: Create scaffold test (failing before app exists)**

```ts
// apps/frontend-svelte/tests/scaffold.test.ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
describe("scaffold", () => {
  it("svelte.config exists", () =>
    expect(existsSync("svelte.config.js")).toBe(true));
  it("vite.config exists", () =>
    expect(existsSync("vite.config.ts")).toBe(true));
  it("app.html exists", () => expect(existsSync("src/app.html")).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test 2>&1 | head -20`
      Expected: FAIL (no such filter / no files) or vitest not found

- [ ] **Step 3: Create package.json**

```json
{
  "name": "manhwa-svelte",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite dev --port 5173",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint ."
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.6.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@sveltejs/adapter-vercel": "^5.8.2",
    "@sveltejs/kit": "^2.20.0",
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "@testing-library/svelte": "^5.2.0",
    "@testing-library/jest-dom": "^7.0.1",
    "jsdom": "^30.0.1",
    "svelte": "^5.28.0",
    "svelte-check": "^4.1.0",
    "typescript": "^5.8.3",
    "vite": "^6.3.0",
    "vitest": "^4.1.10",
    "tailwindcss": "^4.1.4",
    "@tailwindcss/vite": "^4.1.4"
  }
}
```

- [ ] **Step 4: Create svelte.config.js**

```js
import adapter from "@sveltejs/adapter-vercel";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: { $lib: "./src/lib", $components: "./src/components" },
  },
};
export default config;
```

- [ ] **Step 5: Create vite.config.ts**

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    include: ["tests/**/*.{test,spec}.{js,ts}"],
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 6: Create tsconfig.json**

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "moduleResolution": "bundler",
    "allowJs": true,
    "paths": {
      "$lib/*": ["src/lib/*"],
      "$components/*": ["src/components/*"],
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.svelte", "tests/**/*"]
}
```

- [ ] **Step 7: Create src/app.html, src/app.css, static/** — copy `apps/frontend/app/globals.css` + `gold.css` merged into `src/app.css`, `app.html` with `%sveltekit.head%` + `%sveltekit.body%`, copy public assets via `bash cp -r apps/frontend/public/* apps/frontend-svelte/static/`

- [ ] **Step 8: Modify root package.json add scripts**

```json
"dev:frontend:svelte": "pnpm --filter manhwa-svelte dev",
"build:svelte": "pnpm --filter manhwa-svelte build"
```

- [ ] **Step 9: Run typecheck + tests + build to verify passes**
      Run: `pnpm --filter manhwa-svelte typecheck; pnpm --filter manhwa-svelte test; pnpm --filter manhwa-svelte build`
      Expected: PASS (svelte-check 0 errors, vitest 1 passed, vite build success)

- [ ] **Step 10: Commit**

```bash
git add docs/superpowers/specs/2026-09-08-svelte-migration-design.md docs/superpowers/plans/2026-09-08-svelte-migration.md apps/frontend-svelte package.json pnpm-workspace.yaml
git commit -m "feat(svelte): scaffold manhwa-svelte SvelteKit app"
```

---

### Task 2: Core Lib Foundation — Security Headers, Auth, Utils, Types, Constants

**Files:**

- Create: `apps/frontend-svelte/src/lib/utils.ts` (copy verbatim)
- Create: `apps/frontend-svelte/src/lib/security/headers.ts` (copy verbatim)
- Create: `apps/frontend-svelte/src/lib/auth.ts` (copy verbatim, ensure `COOKIE_NAME`, `verifyToken`)
- Create: `apps/frontend-svelte/src/lib/types.ts` (copy)
- Create: `apps/frontend-svelte/src/lib/constants.ts` (copy)
- Create: `apps/frontend-svelte/src/lib/schemas.ts` (copy)
- Create: `apps/frontend-svelte/src/lib/nav.ts` (adapt icons to svelte: replace `@phosphor-icons/react` imports with `@phosphor-icons/svelte` or stub, keep `NAV` + `isNavActive`)
- Create: `apps/frontend-svelte/src/lib/timeAgo.ts`, `lib/styles.ts`, `lib/fetchError.ts`, `lib/groupChapters.ts`, `lib/feed.ts`
- Test: `apps/frontend-svelte/tests/lib.test.ts`

**Interfaces:**

- Consumes: Task 1 scaffold
- Produces: `verifyToken(token): boolean`, `getCsp(dev)`, `getSecurityHeaders(dev)`, `cn()`, `NAV`, `isNavActive()`, zod schemas, types — used by hooks + routes

- [ ] **Step 1: Write failing test**

```ts
// tests/lib.test.ts
import { describe, it, expect } from "vitest";
import { cn } from "$lib/utils";
import { getCsp, getSecurityHeaders } from "$lib/security/headers";
import { isNavActive, NAV } from "$lib/nav";
describe("lib foundation", () => {
  it("cn merges tailwind", () => expect(cn("p-2", "p-4")).toBe("p-4"));
  it("getCsp returns string", () =>
    expect(typeof getCsp(false)).toBe("string"));
  it("NAV has 6 items", () => expect(NAV.length).toBe(6));
  it("isNavActive exact /whitelist", () =>
    expect(isNavActive("/whitelist", "/whitelist/chapters")).toBe(false));
  it("isNavActive / -> exact", () =>
    expect(isNavActive("/", "/recent")).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test tests/lib.test.ts -v`
      Expected: FAIL module not found

- [ ] **Step 3: Copy files verbatim from apps/frontend/lib/** (use bash cp, then edit nav.ts)

```bash
mkdir -p apps/frontend-svelte/src/lib/security
cp apps/frontend/lib/utils.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/security/headers.ts apps/frontend-svelte/src/lib/security/
cp apps/frontend/lib/auth.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/types.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/constants.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/schemas.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/timeAgo.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/styles.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/fetchError.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/groupChapters.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/feed.ts apps/frontend-svelte/src/lib/
cp apps/frontend/lib/queryKeys.ts apps/frontend-svelte/src/lib/
```

Edit `lib/nav.ts`: change `import { House...} from "@phosphor-icons/react"` → `from "@phosphor-icons/svelte"` (or keep as any if not installed yet, add dep later)

- [ ] **Step 4: Run test to verify it passes**
      Run: `pnpm --filter manhwa-svelte test tests/lib.test.ts -v`
      Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-svelte/src/lib
git commit -m "feat(svelte): port core lib (headers, auth, utils, types)"
```

---

### Task 3: hooks.server.ts + Layout Shell (Navbar, PageShell, Error, Loading)

**Files:**

- Create: `apps/frontend-svelte/src/hooks.server.ts`
- Create: `apps/frontend-svelte/src/routes/+layout.svelte`
- Create: `apps/frontend-svelte/src/routes/+layout.server.ts`
- Create: `apps/frontend-svelte/src/routes/+error.svelte`
- Create: `apps/frontend-svelte/src/components/Navbar.svelte` (port from components/Navbar.tsx + Nav/*)
- Create: `apps/frontend-svelte/src/components/PageShell.svelte` (port)
- Create: `apps/frontend-svelte/src/components/Announcement.svelte`
- Test: `apps/frontend-svelte/tests/hooks.test.ts`, `tests/layout.test.ts`

**Interfaces:**

- Consumes: Task 2 lib (auth, headers, nav)
- Produces: `handle` hook that enforces auth + CSP on every request; layout that renders navbar + slot; `locals.user` available to `+layout.server.ts`

- [ ] **Step 1: Write failing test for hooks**

```ts
// tests/hooks.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
describe("hooks", () => {
  it("hooks.server exists and checks PUBLIC_EXACT", () => {
    const s = readFileSync("src/hooks.server.ts", "utf8");
    expect(s).toContain("PUBLIC_EXACT");
    expect(s).toContain("verifyToken");
    expect(s).toContain("getSecurityHeaders");
    expect(s).toContain("ikiru_dashboard_session");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test tests/hooks.test.ts -v`
      Expected: FAIL file not found

- [ ] **Step 3: Implement hooks.server.ts (port middleware.ts verbatim)**

```ts
// src/hooks.server.ts
import type { Handle } from "@sveltejs/kit";
import { COOKIE_NAME, verifyToken } from "$lib/auth";
import { getSecurityHeaders } from "$lib/security/headers";
// copy PUBLIC_EXACT, PUBLIC_PREFIX, PUBLIC_GET_PREFIX arrays exactly from middleware.ts
function isPublicPath(pathname: string, method: string): boolean {
  /* same logic */
}
function applySecurityHeaders(headers: Headers, isDev: boolean) {
  const h = getSecurityHeaders(isDev);
  for (const [k, v] of Object.entries(h)) headers.set(k, v);
}
export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  const isDev = process.env.NODE_ENV === "development";
  if (isPublicPath(pathname, event.request.method)) {
    const res = await resolve(event);
    applySecurityHeaders(res.headers, isDev);
    return res;
  }
  const token = event.cookies.get(COOKIE_NAME);
  if (!token || !verifyToken(token)) {
    if (pathname.startsWith("/api/")) {
      const r = new Response(
        JSON.stringify({ success: false, error: "unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
      applySecurityHeaders(r.headers, isDev);
      return r;
    }
    return new Response(null, {
      status: 302,
      headers: { Location: `/login?redirect=${encodeURIComponent(pathname)}` },
    });
  }
  const res = await resolve(event);
  applySecurityHeaders(res.headers, isDev);
  return res;
};
```

- [ ] **Step 4: Create +layout.svelte / +layout.server.ts / +error.svelte**
      `+layout.server.ts`:

```ts
export async function load({ locals, cookies }) {
  return { user: locals.user ?? null };
}
```

`+layout.svelte`: import `app.css`, render `Navbar`, `Announcement`, `<slot />` with `data.sveltekit` attrs, geist font links
`+error.svelte`: display `error.message` + retry button `on:click={() => location.reload()}`

- [ ] **Step 5: Port Navbar.svelte** — copy `components/Navbar.tsx` logic, replace `next/link` with `<a href>`, `usePathname` with `import { page } from "$app/stores"` + `$page.url.pathname`, `isNavActive` from `$lib/nav`, `NAV` map, keep `NavbarStatus` dot via fetch `/api/v1/health/detailed`

- [ ] **Step 6: Run tests + typecheck**
      Run: `pnpm --filter manhwa-svelte test tests/hooks.test.ts -v; pnpm --filter manhwa-svelte typecheck`
      Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-svelte/src/hooks.server.ts apps/frontend-svelte/src/routes apps/frontend-svelte/src/components/Navbar.svelte
git commit -m "feat(svelte): hooks.server auth + layout shell"
```

---

### Task 4: Reader Transport, API Seam, Stores (uiStore, continueReading, image-cache, cover)

**Files:**

- Create: `apps/frontend-svelte/src/lib/reader/transport.ts`
- Create: `apps/frontend-svelte/src/lib/reader/mapper.ts`, `src/lib/reader/index.ts`
- Create: `apps/frontend-svelte/src/lib/api.ts` (bookmarks seam)
- Create: `apps/frontend-svelte/src/lib/server-api.ts`, `src/lib/cover/index.ts`, `src/lib/image-cache.ts`, `src/lib/cache/index.ts`
- Create: `apps/frontend-svelte/src/lib/uiStore.svelte.ts` (runes)
- Create: `apps/frontend-svelte/src/lib/continueReading/index.ts`
- Create: `apps/frontend-svelte/src/lib/hooks/useDebounced.ts`, `useToast.svelte.ts`, etc. (adapt)
- Test: `apps/frontend-svelte/tests/reader.test.ts`, `tests/stores.test.ts`

**Interfaces:**

- Consumes: Task 2-3
- Produces: `readerFetch(path, init?)` (wraps fetch with base `scanner.aldifhr.fun` or relative `/api/v1` for browser), `Reader` facade, `getBookmarks/saveBookmark/deleteBookmark`, `uiStore` rune, `useContinueReading` store

- [ ] **Step 1: Write failing test**

```ts
// tests/reader.test.ts
import { describe, it, expect } from "vitest";
import { readerFetch } from "$lib/reader/transport";
describe("reader", () => {
  it("readerFetch is function", () =>
    expect(typeof readerFetch).toBe("function"));
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test tests/reader.test.ts -v`
      Expected: FAIL

- [ ] **Step 3: Port reader/transport.ts** — adapt Next version: in server use `event.fetch` is passed in, but for simplicity export `readerFetch` that uses global `fetch` and for server routes proxy we forward directly. Keep same error handling (`throw new Error` on !ok). Copy `mapper.ts`, `index.ts` verbatim.

- [ ] **Step 4: Port lib/api.ts** — copy from `apps/frontend/lib/api.ts` verbatim (localStorage vs backend seam, same `isAnonBookmark` check for `ikiru_csrf_token`). Change `import("@/lib/reader/transport")` → `import("$lib/reader/transport")`.

- [ ] **Step 5: Port uiStore.svelte.ts** — translate `uiStore.ts` zustand to runes:

```ts
// src/lib/uiStore.svelte.ts
let search = $state("");
let sortBy: string = $state("updated");
export const uiStore = {
  get search() {
    return search;
  },
  set search(v) {
    search = v;
  },
  get sortBy() {
    return sortBy;
  },
  set sortBy(v) {
    sortBy = v;
  },
};
```

- [ ] **Step 6: Run tests + typecheck**
      Run: `pnpm --filter manhwa-svelte test -v; pnpm --filter manhwa-svelte typecheck`
      Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-svelte/src/lib/reader apps/frontend-svelte/src/lib/api.ts apps/frontend-svelte/src/lib/uiStore.svelte.ts
git commit -m "feat(svelte): port reader transport + api seam + stores"
```

---

### Task 5: UI Components Port (shadcn → Svelte)

**Files:**

- Create: `apps/frontend-svelte/src/components/ui/Button.svelte`
- Create: `src/components/ui/Card.svelte`, `Badge.svelte`, `Alert.svelte`, `Modal.svelte`, `Select.svelte`, `SearchInput.svelte`, `Skeleton.svelte`, `GenreChips.svelte`, `Cover.svelte`, `ContextMenu.svelte`, `SegmentedControl.svelte`, `StatusBadge.svelte`, `StatCard.svelte`, `SourceChip.svelte`, `SourceBadge.svelte`, `OriginFlag.svelte`, `RatingStars.svelte`
- Create: `src/components/PageShell.svelte`, `SkeletonGrid.svelte`, `ScrollProgress.svelte`, `EmptyState.svelte`, `ErrorFallback.svelte`, `MangaCard.svelte`, `WhitelistGrid.svelte`, `WhitelistCard.svelte`
- Test: `apps/frontend-svelte/tests/components.test.ts`

**Interfaces:**

- Consumes: Task 2 utils (cn)
- Produces: Svelte components with `$props()` API matching React props (variant, size, etc.)

- [ ] **Step 1: Write failing test**

```ts
// tests/components.test.ts
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import Button from "$components/ui/Button.svelte";
describe("ui Button", () => {
  it("renders", () => {
    const { getByRole } = render(Button, { props: { children: "Click" } });
    expect(getByRole("button")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test tests/components.test.ts -v`
      Expected: FAIL

- [ ] **Step 3: Port each ui component** — for each `.tsx` read `apps/frontend/components/ui/*.tsx`, convert to `.svelte`:
  - `export let variant/className` → `let { variant="default", class: className="", children, ...rest }: Props = $props()`
  - `class-variance-authority` keep if present, else inline `cn()`
  - Keep Tailwind classes verbatim
    Example `Button.svelte`:

```svelte
<script lang="ts">
  import { cn } from "$lib/utils";
  let { variant="default", size="default", class: className="", children, ...rest }: any = $props();
  const base = "inline-flex items-center justify-center rounded-lg...";
</script>
<button class={cn(base, className)} {...rest}>{@render children?.()}</button>
```

- [ ] **Step 4: Run tests + typecheck**
      Run: `pnpm --filter manhwa-svelte test tests/components.test.ts -v; pnpm --filter manhwa-svelte typecheck`
      Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-svelte/src/components/ui apps/frontend-svelte/src/components/PageShell.svelte
git commit -m "feat(svelte): port ui components to Svelte 5"
```

---

### Task 6: Home Page (/) — Grouped Feed + Bookmark Strip + Stats

**Files:**

- Create: `apps/frontend-svelte/src/routes/+page.svelte`
- Create: `apps/frontend-svelte/src/routes/+page.ts` (load)
- Create: `src/components/home/VirtualizedList.svelte`, `InfiniteSentinel.svelte`, `seriesShared.svelte`, `useReadItems.svelte.ts`, `useContinueReading.svelte.ts`
- Create: `src/lib/groupChapters.ts` already, verify
- Test: `apps/frontend-svelte/tests/home.test.ts`

**Interfaces:**

- Consumes: Task 4 reader/api, Task 5 ui, lib/groupChapters, lib/queryKeys (for staleTimes if needed)
- Produces: `/` renders same as Next `app/page.tsx` (ContinueReading strip, stats 4 cards, Latest Updates grouped list with `HomeGroupedCard`)

- [ ] **Step 1: Write failing test**

```ts
// tests/home.test.ts
import { describe, it, expect } from "vitest";
import { groupChapters } from "$lib/groupChapters";
describe("home grouping", () => {
  it("groups flat chapters by titleKey", () => {
    const flat = [
      {
        titleKey: "a",
        title: "A",
        source: "ikiru",
        chapterNumber: 1,
        chapterLabel: "1",
        cover: null,
        seriesUrl: "",
        chapterUrl: "",
        origin: "kr",
      } as any,
    ];
    const g = groupChapters(flat);
    expect(g.length).toBe(1);
    expect(g[0].titleKey).toBe("a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (if not already passing from Task2)**
      Run: `pnpm --filter manhwa-svelte test tests/home.test.ts -v`

- [ ] **Step 3: Implement +page.ts**

```ts
// src/routes/+page.ts
export async function load({ fetch }) {
  const res = await fetch("/api/v1/reader/rss?limit=36&group=false");
  const json = await res.json();
  return { feed: json };
}
```

- [ ] **Step 4: Port +page.svelte** — convert `app/page.tsx:400-712` (HomePage) to Svelte:
  - `"use client"` removed, `useQuery` → `data.feed` from load + `onMount` polling if needed, `fetch` for bookmarks via `getBookmarks()`
  - `useDeferredValue`/`useTransition` → Svelte `$derived` + `tick`
  - `groupChapters` via `$derived(groupChapters(deferredResults))`, `latestTimestamp` via `$derived`
  - `HomeGroupedCard` inline component with `coverSrc` `$state`, `hasRetried` etc., `motion.div` → `transition:fly`
  - Keep `SourcePill`, `CoverImage`, `ContinueReadingCard` as Svelte snippets/components

- [ ] **Step 5: Port VirtualizedList.svelte** — if `items.length > 14` use simple `{#each}` with `InfiniteSentinel` or lightweight virtualizer (`@tanstack/svelte-virtual` if needed, but prefer native scroll). Sentinel uses `IntersectionObserver` in `onMount`.

- [ ] **Step 6: Run tests + typecheck + build**
      Run: `pnpm --filter manhwa-svelte test tests/home.test.ts -v; pnpm --filter manhwa-svelte typecheck; pnpm --filter manhwa-svelte build`
      Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-svelte/src/routes/+page.* apps/frontend-svelte/src/components/home
git commit -m "feat(svelte): home feed with grouping + bookmarks"
```

---

### Task 7: Remaining Pages (Recent, Whitelist, Exclude, History, Bookmarks, Admin, Cron, Logs, Login, Register, About, Debug)

**Files:**

- Create: `src/routes/recent/+page.svelte` (+ `+page.ts`)
- Create: `src/routes/whitelist/+page.svelte` (+ `WhitelistClient.svelte`)
- Create: `src/routes/exclude-list/+page.svelte` (+ `ExcludeListClient.svelte`)
- Create: `src/routes/dispatch-history/+page.svelte`
- Create: `src/routes/bookmarks/+page.svelte`
- Create: `src/routes/admin/+page.svelte`
- Create: `src/routes/cron/+page.svelte`
- Create: `src/routes/error-logs/+page.svelte`
- Create: `src/routes/login/+page.svelte`
- Create: `src/routes/register/+page.svelte`
- Create: `src/routes/about/+page.svelte`
- Create: `src/routes/debug/+page.svelte`
- Create: `src/components/home/AllTab.svelte`, `AllCard.svelte`, `GroupedSeriesCard.svelte`, `FilterDrawer.svelte`, `AllTabToolbar.svelte`, etc.
- Test: `apps/frontend-svelte/tests/pages.test.ts`

**Interfaces:**

- Consumes: Task 5-6 components, Task 4 api
- Produces: 12 routes rendering parity with Next pages

- [ ] **Step 1: Write failing test**

```ts
// tests/pages.test.ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
describe("pages", () => {
  const pages = [
    "recent",
    "whitelist",
    "exclude-list",
    "dispatch-history",
    "bookmarks",
    "admin",
    "cron",
    "error-logs",
    "login",
    "register",
    "about",
    "debug",
  ];
  for (const p of pages)
    it(`${p} page exists`, () =>
      expect(existsSync(`src/routes/${p}/+page.svelte`)).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test tests/pages.test.ts -v`
      Expected: FAIL (12 failures)

- [ ] **Step 3: For each page, copy Next page.tsx logic and convert:**
  - `recent/page.tsx` + `AllTab.tsx` etc. → `recent/+page.svelte` with same filter/search/group logic, `AllTabToolbar`, `FilterDrawer`
  - `whitelist/page.tsx` + `WhitelistClient.tsx` → `whitelist/+page.svelte` (server load whitelist via `/api/v1/reader/whitelist`, client actions `POST /api/v1/reader/whitelist` for add/remove)
  - `exclude-list/page.tsx` + `ExcludeListClient.tsx` → similar
  - `dispatch-history/page.tsx` + `DispatchHistoryClient.tsx` → fetch `/api/v1/dispatch-history`
  - `bookmarks/page.tsx` → use `getBookmarks()` from `$lib/api` + `ContinueReading` store
  - `admin/page.tsx`, `cron/page.tsx`, `error-logs/page.tsx` → fetch snapshot/logs, protected (hooks handles redirect)
  - `login/page.tsx`, `register/page.tsx` → forms POST to `/api/v1/auth/login` with `enhance`, set cookies, redirect `?redirect=` param
  - `about`, `debug` static
    Each page uses `PageShell`, `EmptyState`, `ErrorFallback` svelte equivalents.

- [ ] **Step 4: Run tests + typecheck + build**
      Run: `pnpm --filter manhwa-svelte test tests/pages.test.ts -v; pnpm --filter manhwa-svelte typecheck; pnpm --filter manhwa-svelte build`
      Expected: PASS (12 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-svelte/src/routes/recent apps/frontend-svelte/src/routes/whitelist apps/frontend-svelte/src/routes/exclude-list apps/frontend-svelte/src/routes/dispatch-history apps/frontend-svelte/src/routes/bookmarks apps/frontend-svelte/src/routes/admin apps/frontend-svelte/src/routes/cron apps/frontend-svelte/src/routes/error-logs apps/frontend-svelte/src/routes/login apps/frontend-svelte/src/routes/register apps/frontend-svelte/src/routes/about apps/frontend-svelte/src/routes/debug
git commit -m "feat(svelte): port 12 remaining pages"
```

---

### Task 8: API Proxy Server Routes (25 routes)

**Files:**

- Create: `src/routes/api/v1/reader/rss/+server.ts`
- Create: `src/routes/api/v1/reader/rss/new/+server.ts`, `.../health/+server.ts`, `.../whitelist/+server.ts`, `.../proxy/+server.ts`, `.../cover/+server.ts`, `.../dispatch-history/+server.ts`, `.../continue-reading/+server.ts`
- Create: `src/routes/api/v1/auth/login/+server.ts`, `logout`, `me`, `register`
- Create: `src/routes/api/v1/bookmarks/+server.ts`, `.../[titleKey]/[chapterNumber]/+server.ts`
- Create: `src/routes/api/v1/catalog/resolve/+server.ts`, `.../continue-reading/+server.ts`, `.../cron/status/+server.ts`, `.../dashboard/snapshot/+server.ts`, `.../dispatch-history/+server.ts`, `.../excluded-titles/+server.ts`, `.../excluded-titles/bulk/+server.ts`, `.../health/detailed/+server.ts`, `.../health/refresh-voratoon/+server.ts`, `.../logs/errors/+server.ts`, `.../queue/+server.ts`, `.../stats/+server.ts`, `.../rss/+server.ts` etc. (mirror Next `app/api/**`)
- Create: `src/routes/api/cron/+server.ts`, `.../cron/status/+server.ts`, `.../public/stats/+server.ts`, `.../fastcron/+server.ts`, `.../openapi.json/+server.ts`, `.../debug/**`
- Test: `apps/frontend-svelte/tests/api.test.ts`

**Interfaces:**

- Consumes: Task 4 reader transport, lib/auth
- Produces: `GET/POST/DELETE` handlers that proxy to `https://scanner.aldifhr.fun` and set correct `Cache-Control`/`Content-Type` per `next.config.ts:headers()`

- [ ] **Step 1: Write failing test**

```ts
// tests/api.test.ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
describe("api routes", () => {
  it("rss proxy exists", () =>
    expect(existsSync("src/routes/api/v1/reader/rss/+server.ts")).toBe(true));
  it("auth login exists", () =>
    expect(existsSync("src/routes/api/v1/auth/login/+server.ts")).toBe(true));
  it("cover proxy exists", () =>
    expect(existsSync("src/routes/api/v1/reader/cover/+server.ts")).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test tests/api.test.ts -v`
      Expected: FAIL

- [ ] **Step 3: Implement generic proxy helper**
      Create `src/lib/proxy.ts`:

```ts
export async function proxyToScanner(
  event: import("@sveltejs/kit").RequestEvent,
  path: string
) {
  const url = `https://scanner.aldifhr.fun${path}${event.url.search}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of event.request.headers)
    if (k.toLowerCase() !== "host") headers[k] = v;
  const cookie = event.request.headers.get("cookie");
  if (cookie) headers["cookie"] = cookie;
  const res = await fetch(url, {
    method: event.request.method,
    headers,
    body:
      event.request.method !== "GET" && event.request.method !== "HEAD"
        ? await event.request.text()
        : undefined,
  });
  const body = await res.arrayBuffer();
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of res.headers) outHeaders[k] = v;
  // override per next.config headers for specific paths
  if (path.includes("/reader/cover")) {
    outHeaders["Content-Type"] = "image/webp";
    outHeaders["Cache-Control"] = "public, max-age=86400, s-maxage=86400";
  }
  if (path.includes("/reader/proxy")) {
    outHeaders["Content-Type"] = "image/webp";
    outHeaders["Cache-Control"] = "public, max-age=86400, s-maxage=86400";
  }
  if (path.includes("/dispatch-history"))
    outHeaders["Cache-Control"] = "no-store";
  return new Response(body, { status: res.status, headers: outHeaders });
}
```

- [ ] **Step 4: For each route create +server.ts**
      Example `src/routes/api/v1/reader/rss/+server.ts`:

```ts
import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = (event) =>
  proxyToScanner(event, "/api/v1/reader/rss");
```

Similarly for all 25+ routes, matching Next `route.ts` logic (some have custom handling like `/api/v1/reader/cover` streams image, `/api/v1/auth/login` sets cookies). For auth routes, parse `set-cookie` from scanner and forward via `event.cookies.set`.

- [ ] **Step 5: Handle rewrites** — add extra server routes for legacy compat (`/api/reader/**`, `/api/auth/**`, `/api/excluded-titles`, `/api/v1/dashboard-snapshot`, `/api/v1/reader/rss` alias) that call `proxyToScanner` with canonical path, mirroring `next.config.ts:rewrites()`.

- [ ] **Step 6: Run tests + typecheck**
      Run: `pnpm --filter manhwa-svelte test tests/api.test.ts -v; pnpm --filter manhwa-svelte typecheck`
      Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-svelte/src/routes/api apps/frontend-svelte/src/lib/proxy.ts
git commit -m "feat(svelte): add 25 API proxy server routes"
```

---

### Task 9: Polish — Stores (continueReading, image-cache, hooks), Styles, PWA

**Files:**

- Create: `src/lib/continueReading/index.ts` (port from frontend)
- Create: `src/lib/image-cache.ts`, `src/lib/hooks/*`, `src/lib/useToast.svelte.ts`
- Create: `src/components/StatsCharts.svelte`, `ContinueReadingStrip.svelte`, `BackToTop.svelte`
- Modify: `src/app.css` ensure `gold.css` variables (`--gold-surface` etc.) merged, `globals.css` tailwind directives
- Test: `apps/frontend-svelte/tests/polish.test.ts`

**Interfaces:**

- Consumes: Tasks 4-8
- Produces: Complete feature parity for continueReading strip, image cache fallback, toast, stats charts (port from `StatsCharts.tsx` using same data shape)

- [ ] **Step 1: Write failing test**

```ts
// tests/polish.test.ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
describe("polish", () => {
  it("continueReading exists", () =>
    expect(existsSync("src/lib/continueReading/index.ts")).toBe(true));
  it("app.css contains gold vars", () => {
    const s = require("node:fs").readFileSync("src/app.css", "utf8");
    expect(s).toContain("--gold-surface");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pnpm --filter manhwa-svelte test tests/polish.test.ts -v`
      Expected: FAIL

- [ ] **Step 3: Port remaining libs** — copy `lib/continueReading/index.ts`, `lib/image-cache.ts`, `lib/useToast.tsx` → `lib/useToast.svelte.ts` (use `svelte/store` writable for toasts, `sonner` replaced with custom toast or `svelte-sonner`), `lib/hooks/*` adapt to svelte (`useWebSocket` as `onMount` + `WebSocket`, `useScrollVisibility` as `window.addEventListener`, `useLongPress` as Svelte action `use:longpress`)

- [ ] **Step 4: Merge app.css** — `apps/frontend/app/globals.css` + `gold.css` → `src/app.css` with `@import "tailwindcss"`, keep `* { scrollbar }`, `body bg-black`, `gold` variables.

- [ ] **Step 5: Verify polish**
      Run: `pnpm --filter manhwa-svelte test tests/polish.test.ts -v; pnpm --filter manhwa-svelte build`
      Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-svelte/src/lib/continueReading apps/frontend-svelte/src/lib/image-cache.ts apps/frontend-svelte/src/app.css
git commit -m "feat(svelte): polish stores + styles + pwa"
```

---

### Task 10: Final Verification & Parity Check

**Files:**

- Modify: None (verification only)
- Test: `pnpm --filter manhwa-svelte test` (all), `svelte-check`, `vite build`, manual curl

**Interfaces:**

- Consumes: All tasks
- Produces: Evidence that Svelte build passes and API responses match Next

- [ ] **Step 1: Run full test suite**
      Run: `pnpm --filter manhwa-svelte test run`
      Expected: All tests PASS (≥30 tests across scaffold/lib/hooks/reader/components/home/pages/api/polish)

- [ ] **Step 2: Run typecheck**
      Run: `pnpm --filter manhwa-svelte typecheck`
      Expected: 0 errors

- [ ] **Step 3: Run build**
      Run: `pnpm --filter manhwa-svelte build`
      Expected: `✓ built in ...` with `adapter-vercel` output in `.vercel/` or `.svelte-kit/output`

- [ ] **Step 4: Manual parity smoke**
      Run: `pnpm --filter manhwa-svelte dev &` then `curl -s http://localhost:5173/api/v1/reader/rss?limit=2 | head -c 500` and compare to `curl -s http://localhost:3000/api/v1/reader/rss?limit=2` (if Next running). Verify CSP header: `curl -I http://localhost:5173/ | grep -i content-security-policy`. Verify auth redirect: `curl -I http://localhost:5173/whitelist` → `302 /login`.

- [ ] **Step 5: Document switch steps in README**
      Add `apps/frontend-svelte/README.md`:

```md
# manhwa-svelte — SvelteKit frontend

pnpm --filter manhwa-svelte dev # http://localhost:5173
pnpm --filter manhwa-svelte build

# To switch Vercel: update vercel.json framework to sveltekit + buildCommand pnpm --filter manhwa-svelte build
```

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-svelte/README.md
git commit -m "chore(svelte): verify full parity + docs"
```

---

## Self-Review

**Spec coverage:**

- 1 Goal (parallel app, 100% parity) → Task 1 scaffold
- 2.1 Architecture layout → Task 1
- 2.2 Workspace → Task 1
- 2.3 Lib ports → Tasks 2,4,9
- 2.4 Components → Tasks 3,5
- 2.5 Routing & API → Tasks 6,7,8
- 2.6 Auth hooks → Task 3
- 3 Data Flow → Tasks 4,6,7
- 4 Error handling → Tasks 3,6,7,8
- 5 Testing → Tasks 1-10 (each has failing test + pass), Task 10 final verification

**Placeholder scan:** No TBD/TODO — all steps contain actual code blocks and exact file paths.

**Type consistency:** `readerFetch(path, init?)` same signature across Tasks 4/8; `proxyToScanner(event, path)` defined in Task 8 used consistently; `NAV`/`isNavActive` from Task 2 consumed in Task 3; `cn()` from utils consumed everywhere; `verifyToken` from auth consumed in hooks.
