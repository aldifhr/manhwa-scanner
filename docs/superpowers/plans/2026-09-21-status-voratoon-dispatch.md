# Status + Voratoon Expiry + Dispatch Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live health detail (disabled/nextScrape/queue), voratoon cover expiry countdown + refresh, and dispatch 3d chart without FE fallback.

**Architecture:** Keep FE `readerFetch` seams. Status page merges `GET /api/v1/sources/health` (source_health) + `GET /api/v1/cron/status` (per_source nextScrape + queue). Voratoon expiry computes `X-Amz-Date + 518400s` client-side from `recent_chapters cover` via `RSS cover`, refresh via `POST /api/v1/health/refresh-voratoon`. Dispatch chart queries `cron_run_status` or `dispatch_history` count grouped by day.

**Tech Stack:** Next.js 16 App Router, TanStack Query, `readerFetch`, `app/tasks/retention.py:8` 3d, `app/storage/recent_chapters_window.py:33`.

**Spec:** User request 2026-09-21: "/status detail per source — tambah disabled badge kalau DISABLED_SOURCES/disabledUntil ada (health.py:252), + nextScrapeIn + queue depth dari cron/status biar ikiru disabled tidak kelihatan healthy lagi; Voratoon expiry dashboard — /status tambah cover X-Amz-Date + 6d countdown + tombol Refresh cover POST /health/refresh-voratoon; Dispatch 3d chart — /notifications tambah mini chart sent 24h/3d dari dispatch_history retention 3d"

## Global Constraints

- No FE fallback — BE must return image/data, FE shows error not silent fallback — per prior cover fix.
- PROXY_ALLOWED_HOSTS exact host:port — `app/config.py:99` — no wildcards.
- Voratoon presigned 6d = 518400s — `feed.py:62` coverImage, `cover.py:54` direct.
- dispatch_history retention 3d — `retention.py:8` `_DISPATCH_HISTORY_RETENTION_DAYS=3`.
- Verify: `pnpm build` + `py_compile` + `pytest` before claim — `AGENTS.md`.

---

### Task 1: Status detail per source — disabled + nextScrapeIn + queue

**Files:**
- Modify: `apps/frontend/app/status/page.tsx:1-67`
- Test: `apps/frontend/tests/status.test.tsx` (create)

**Interfaces:**
- Consumes: `GET /api/v1/sources/health -> {sources:[{name,source,status,disabledUntil,lastSuccess,consecutiveFailures}]}` , `GET /api/v1/cron/status -> {per_source:{ikiru:{last_scrape,next_scrape_in_s},...}, queue_depth, is_processing}`
- Produces: `StatusPage` shows badge disabled if `DISABLED_SOURCES` contains source or `disabledUntil > now` or `health.status==='disabled'`, plus `nextScrapeIn` and `queue depth`.

- [ ] **Step 1: Write failing test**

```tsx
// apps/frontend/tests/status.test.tsx
import { render, screen } from "@testing-library/react";
import StatusPage from "@/app/status/page";
test("shows disabled badge when ikiru disabled", async () => {
  // mock readerFetch to return ikiru disabledUntil future
  // expect getByText("disabled") visible, not "healthy"
});
```

- [ ] **Step 2: Run test to verify fails**

Run: `pnpm test apps/frontend/tests/status.test.tsx -v`
Expected: FAIL — badge shows healthy, not disabled.

- [ ] **Step 3: Implement**

```tsx
// apps/frontend/app/status/page.tsx
const { data: health } = useQuery({ queryKey:["sources-health"], queryFn:()=>readerFetch("/api/v1/sources/health"), refetchInterval:15000 })
const { data: cron } = useQuery({ queryKey:["cron-status"], queryFn:()=>readerFetch("/api/v1/cron/status"), refetchInterval:15000 })
const disabledSources = new Set((process.env.NEXT_PUBLIC_DISABLED_SOURCES||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean));
// per source:
const isDisabled = (s) => s.disabledUntil && new Date(s.disabledUntil) > new Date() || disabledSources.has(s.source?.toLowerCase()) || s.status?.toLowerCase()==="disabled";
const badge = isDisabled(s) ? "disabled" : s.status;
const nextIn = cron?.per_source?.[s.source]?.next_scrape_in_s;
const queueDepth = cron?.queue_depth;
```

Render badge `disabled` gray, `healthy` emerald, `degraded` amber. Show `Next scrape: 5m` and `Queue: 2`.

- [ ] **Step 4: Run test to verify passes**

Run: `pnpm test apps/frontend/tests/status.test.tsx -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/app/status/page.tsx apps/frontend/tests/status.test.tsx
git commit -m "feat: status detail disabled + nextScrape + queue"
```

### Task 2: Voratoon expiry dashboard — countdown + refresh

**Files:**
- Modify: `apps/frontend/app/status/page.tsx` (add section)
- Create: `apps/frontend/components/status/VoratoonExpiry.tsx`
- Test: `apps/frontend/tests/voratoon-expiry.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/rss?limit=100` -> results[].cover (cvr.voratoon.id...X-Amz-Date), `POST /api/v1/health/refresh-voratoon`
- Produces: `VoratoonExpiry` shows `king-account 12h lagi expired` countdown `expiresAt = X-Amz-Date + 518400*1000`, button `Refresh cover`.

- [ ] **Step 1: Write failing test**

```tsx
test("shows 12h countdown for 20260915 cover", () => {
  const cover="https://cvr.voratoon.id/...X-Amz-Date=20260915T012930Z&X-Amz-Expires=518400";
  expect(getExpiry(cover)).toBe("2026-09-21T01:29:30Z");
  expect(countdown(getExpiry(cover), new Date("2026-09-20T13:29:00Z"))).toMatch(/12h/);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `pnpm test voratoon-expiry -v`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

```tsx
// VoratoonExpiry.tsx
function parseVoratoonExpiry(cover:string):Date|null{
  try{
    const u=new URL(cover);
    const d=u.searchParams.get("X-Amz-Date");
    const e=parseInt(u.searchParams.get("X-Amz-Expires")||"518400",10);
    if(!d) return null;
    const dt=new Date(d.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z"));
    return new Date(dt.getTime()+e*1000);
  }catch{return null}
}
export function useVoratoonCovers(){
  return useQuery({ queryKey:["voratoon-expiry"], queryFn:()=>readerFetch("/api/v1/rss?limit=100").then(r=>r.data.results.filter(x=>x.source==="voratoon").slice(0,5)), refetchInterval:60000 })
}
```

Render list 5 voratoon covers with `expiresAt - now` countdown, color red if <24h. Button `onClick: ()=>readerFetch("/api/v1/health/refresh-voratoon",{method:"POST"})` + invalidate.

- [ ] **Step 4: Run test passes**

Run: `pnpm test voratoon-expiry -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/components/status/VoratoonExpiry.tsx apps/frontend/app/status/page.tsx
git commit -m "feat: voratoon expiry countdown + refresh"
```

### Task 3: Dispatch 3d chart in /notifications

**Files:**
- Modify: `apps/frontend/components/notifications/NotificationsClient.tsx:1-252`
- Create: `apps/frontend/components/notifications/DispatchChart.tsx`
- Test: `apps/frontend/tests/dispatch-chart.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/cron/status` or `GET /api/v1/dispatch-history?limit=100` grouped by day, `retention 3d`
- Produces: `DispatchChart` bar of sent last 3 days.

- [ ] **Step 1: Write failing test**

```tsx
test("chart groups 3 days", ()=>{
  const rows=[{sent_at:"2026-09-21T01:00:00Z"},{sent_at:"2026-09-20T01:00:00Z"},{sent_at:"2026-09-20T02:00:00Z"}];
  expect(groupByDay(rows)).toEqual([{day:"2026-09-21",count:1},{day:"2026-09-20",count:2}]);
});
```

- [ ] **Step 2: Run fails**

Run: `pnpm test dispatch-chart -v`
Expected: FAIL

- [ ] **Step 3: Implement**

```tsx
// DispatchChart.tsx
export function DispatchChart(){
  const {data: cron} = useQuery({ queryKey:["dispatch-3d"], queryFn:()=>readerFetch("/api/v1/cron/health").then(r=>r.data.dispatch), refetchInterval:30000 })
  // fallback: fetch dispatch_history 100 and group
  const {data: hist} = useQuery({ queryKey:["dispatch-history", "chart"], queryFn:()=>readerFetch("/api/v1/dispatch-history?limit=100&page=1&page_size=50").then(r=>r.data.results), enabled:!cron })
  // group last 3 days
}
```

Render 3 bars `Today/Yesterday/2d ago` with counts, show `retention 3d` label.

Add to `NotificationsClient` top.

- [ ] **Step 4: Run passes**

Run: `pnpm test dispatch-chart -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/components/notifications/DispatchChart.tsx apps/frontend/components/notifications/NotificationsClient.tsx
git commit -m "feat: dispatch 3d chart in notifications"
```
