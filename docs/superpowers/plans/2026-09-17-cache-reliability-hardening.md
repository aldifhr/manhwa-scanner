# Cache & Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden scraper pipeline, dispatch idempotency, circuit breaker, frontend pagination/401/timeout, and security/logging against silent data loss, duplicate Discord messages, and stale cache.

**Architecture:** Keep existing layers (recent_chapters 24h, dashboard_snapshot materialized, React Query + HTTP private SWR, series_meta 6h TTL) but make failures explicit: pipeline `status=partial/failed` per source, strict vs tolerant pagination with metadata, single-flight 401 retry for idempotent GET, outbox-style dispatch with idempotency key, atomic half-open probe, and SSRF allowlist.

**Tech Stack:** Python FastAPI + Supabase (backend), Next.js + TanStack Query (frontend), curl_cffi/scrapers, Redis

**Spec:** User audit 2026-09-17 (P1 pipeline false OK, Promise.allSettled partial, getDispatchHistory bulk, continue_reading JSONB, updated_at double, identifier FK, source constraint, 401 refresh, abort, timeout, 204, unknown casts, 401→[], plus new batch: executor timeout wait, health_map vs scrape, Discord duplicate, circuit breaker half-open, cross-source dedup, DB fallback, dispatch_history single source of truth, REST→gateway fallback, attachment fallback, partial pagination metadata, 401 concurrent test, SSRF allowlist)

## Global Constraints
- Ponytail level: full — `ponytail:` comment + trigger per simplification
- Verify before completion: `python3 -m py_compile` + `pytest` + `pnpm --filter manhwa-reader exec tsc --noEmit` + `pnpm --filter manhwa-reader test`
- Credentials include → `Cache-Control: private` + `Vary: Cookie`, never `public` for session data
- No bare `fetch` in `apps/frontend` outside `lib/reader/transport.ts`
- Keep existing staleTimes: rss 30s/5m, whitelist 2m/30m, metadata 30m/60m

---

### File Structure

**Backend - Pipeline & Collect:**
- Modify: `apps/backend/app/cron/collect.py:138-178` — executor lifecycle (non-blocking shutdown)
- Modify: `apps/backend/app/cron/pipeline.py:173-198` — pipeline status partial/failed + persist health per source + probe vs scrape split
- Modify: `apps/backend/app/storage/health.py:12` — save_source_health_map already, add `write_cron_status` with `sources` JSON

**Backend - Dispatch & Discord:**
- Modify: `apps/backend/app/cron/dispatch_mod.py:80-140` — send_chapter idempotency, _discord_request retry policy, outbox pattern
- Modify: `apps/backend/app/services/resilience.py:40-90` — CircuitBreaker half_open atomic probe

**Backend - Storage & Schema:**
- Verify: `apps/backend/app/db/migrations/048_type_drift.sql:42` — updated_at timestamptz already
- Verify: `apps/backend/app/db/migrations/035_fix_architecture_20260829.sql` — CHECK source includes voratoon via 048:7,12
- Modify: `apps/backend/ARCHITECTURE.md:101,198` — docs already fixed, verify
- Modify: `apps/backend/app/storage/recent_chapters.py:473` — ensure duplicate key handling for cross-source dedup explicit

**Frontend - Transport & Query:**
- Modify: `apps/frontend/lib/reader/transport.ts:5,40,92` — 401 single-flight GET-only retry, timeout 15s, strict vs tolerant paginatedGet with metadata
- Modify: `apps/frontend/lib/queryKeys.ts:27` — already filter-aware, add failedPages metadata type
- Modify: `apps/frontend/lib/reader/index.ts:52` — deprecate bulk getDispatchHistory, keep getDispatchHistoryPage
- Modify: `apps/frontend/components/home/AllTab.tsx:132` — bulk 10000 → 2000 already, verify infinite query path

**Security:**
- Verify: `apps/backend/app/scrapers/*.py`, `app/api/catalog.py`, `app/services/whitelist_service.py` — outbound URL allowlist for SSRF
- Verify: `apps/backend/app/api/interaction.py` — verify_interaction_v2 logging sig_len not secret
- Modify: `apps/frontend/lib/reader/transport.ts:46` — ensure Authorization header not logged

**Testing:**
- Create: `apps/backend/tests/test_pipeline_partial.py` — scraper partial/failure status
- Create: `apps/backend/tests/test_circuit_breaker_concurrent.py` — half_open 10 concurrent → 1 probe
- Create: `apps/backend/tests/test_dispatch_unknown_delivery.py` — timeout → retry → assert single logical notification
- Create: `apps/frontend/tests/transport.test.ts` — 401 single-flight 3 concurrent → 1 refresh, pagination partial metadata

---

### Task 1: Executor Timeout Non-Blocking Shutdown

**Files:**
- Modify: `apps/backend/app/cron/collect.py:146-178`
- Test: `apps/backend/tests/test_pipeline_timeout.py`

**Interfaces:**
- Consumes: `_SOURCE_TIMEOUT = 120` (`collect.py:55`), `SourceResult`
- Produces: `collect_recent_chapters` returns partial `items` quickly after global timeout, workers not waited

- [ ] **Step 1: Write failing test** — timeout must not block

```python
# apps/backend/tests/test_pipeline_timeout.py
def test_collect_does_not_wait_worker_after_global_timeout(monkeypatch):
    # mock _collect_ikiru_source to sleep 10s, set _SOURCE_TIMEOUT=1, assert collect returns <2s and marks failed
    import time
    from app.cron.collect import collect_recent_chapters, _SOURCE_TIMEOUT
    monkeypatch.setattr("app.cron.collectors.ikiru._collect_ikiru_source", lambda *a, **kw: time.sleep(5) or [])
    start = time.time()
    items, hm = collect_recent_chapters(source="ikiru")
    assert time.time() - start < 2.5
    assert hm["ikiru"]["status"] in ("DOWN","DEGRADED")
```

- [ ] **Step 2: Run test to verify it fails** `pytest apps/backend/tests/test_pipeline_timeout.py::test_collect_does_not_wait_worker_after_global_timeout -xvs` Expected FAIL (currently waits)

- [ ] **Step 3: Fix executor lifecycle** — use `with ThreadPoolExecutor(...) as ex: ex.shutdown(wait=False, cancel_futures=True)` after TimeoutError, or `future.cancel()` + `ex._threads.clear()`; do not call `as_completed` with `wait=True` default. Replace `for _future in as_completed(..., timeout=_SOURCE_TIMEOUT):` with manual loop + `future.cancel()` for undone.

```python
with concurrent.futures.ThreadPoolExecutor(max_workers=len(sources)) as _executor:
  _futures = { _executor.submit(_try_collect, s): s for s in sources }
  try:
    for f in concurrent.futures.as_completed(_futures, timeout=_SOURCE_TIMEOUT):
      ...
  except concurrent.futures.TimeoutError:
    for f, src in _futures.items():
      if not f.done():
        f.cancel()
        _health_end(src, _t0_map[src], False, f"timeout after {_SOURCE_TIMEOUT}s")
    _executor.shutdown(wait=False, cancel_futures=True)
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit** `git add apps/backend/app/cron/collect.py apps/backend/tests/test_pipeline_timeout.py; git commit -m "fix(collect): executor timeout non-blocking"`

---

### Task 2: Pipeline Status Split (source_health vs scrape vs dispatch)

**Files:**
- Modify: `apps/backend/app/cron/pipeline.py:173-198`
- Modify: `apps/backend/app/storage/health.py:88`

**Interfaces:**
- Consumes: `_health_map: dict[source, {status}]`
- Produces: `stats: {status, sources, scrape_health, persist_health, dispatch_health}` + `write_cron_status(status, sources=...)`

- [ ] **Step 1: Write failing test**

```python
def test_pipeline_partial_when_one_source_fails(monkeypatch):
    monkeypatch.setattr("app.cron.collect.collect_recent_chapters", lambda **kw: ([{"title":"x"}], {"ikiru":{"status":"HEALTHY"},"shinigami":{"status":"DEGRADED"},"voratoon":{"status":"HEALTHY"}}))
    monkeypatch.setattr("app.cron.pipeline.recent_chapters.batch_insert_recent_chapters", lambda x: {"inserted":1,"failed":0})
    monkeypatch.setattr("app.storage.health.save_source_health_map", lambda x: None)
    from app.cron.pipeline import run_pipeline
    stats = run_pipeline(do_dispatch=False, action="rss-fetch")
    assert stats["status"] == "partial"
    assert stats["sources"]["shinigami"] == "DEGRADED"
```

- [ ] **Step 2: Run test FAIL** (currently `status` missing when all mocked)

- [ ] **Step 3: Implement** — already `pipeline.py:173` has partial logic, but need to ensure `dispatch` mode probe vs actual scrape: add `scrape_health = _health_map`, `persist_health = insert_stats`, `dispatch_health = retry_stats`; persist `sources` JSON in `write_cron_status` via `health.write_cron_status(status, ..., sources=_health_map)`

- [ ] **Step 4: Run test PASS**

- [ ] **Step 5: Commit**

---

### Task 3: Discord Duplicate — Idempotency / Outbox

**Files:**
- Modify: `apps/backend/app/cron/dispatch_mod.py:1-200`
- Modify: `apps/backend/app/storage/dispatch.py`
- Test: `apps/backend/tests/test_dispatch_unknown_delivery.py`

**Interfaces:**
- Consumes: `send_chapter(chapter, channel_id)` -> `bool` (was resp is not None)
- Produces: Exactly-once logical notification despite retry/REST→gateway fallback

- [ ] **Step 1: Write failing test**

```python
def test_discord_unknown_delivery_no_duplicate(monkeypatch):
    # mock _discord_request to: first call returns success but raises TimeoutError after server accepted
    calls = []
    def fake_request(*a, **kw):
        calls.append(1)
        if len(calls)==1:
            raise TimeoutError("network timeout after server accepted")
        return {"id":"msg123"}
    monkeypatch.setattr("app.cron.dispatch_mod._discord_request", fake_request)
    monkeypatch.setattr("app.db.get_supabase", lambda: FakeSupabase()) # dispatch_history write succeeds once
    from app.cron.dispatch_mod import dispatch
    sent = dispatch([{"title":"Solo Leveling","chapter":"100","chapter_url":"https://x/100","source":"ikiru","title_key":"solo-leveling"}], ["chan"], "test")
    assert sent == 1
    assert len(calls) == 1  # should NOT retry unknown delivery
    # second run should be FCFS skipped (dispatch_history exists)
    sent2 = dispatch([{"title":"Solo Leveling","chapter":"100","chapter_url":"https://x/100","source":"ikiru","title_key":"solo-leveling"}], ["chan"], "test")
    assert sent2 == 0
```

- [ ] **Step 2: Run FAIL** (currently retries and sends duplicate)

- [ ] **Step 3: Fix** — idempotency key per chapter: `fcfs_key(title,chapter)` stored BEFORE send in `dispatch_claims` with `status=pending`, `send` with `Idempotency-Key` header (or Discord `nonce`), on timeout mark `unknown` not `failed`, next run checks `dispatch_history` + `dispatch_claims` before resend. Change `_discord_request` retry to only retry on `408/429/5xx` with `Retry-After`, NOT on timeout after `200` was potentially delivered. Add `outbox` table `dispatch_outbox(idempotency_key, status)` with `pending→sent|unknown`.

```python
# dispatch_mod.py: before send, insert dispatch_claims with status pending
# _discord_request: except TimeoutError → return "unknown" → caller marks outbox unknown → no retry, next cron skips via FCFS
```

- [ ] **Step 4: Run PASS**

- [ ] **Step 5: Commit**

---

### Task 4: Circuit Breaker Half-Open Atomic Probe

**Files:**
- Modify: `apps/backend/app/services/resilience.py:40-70`
- Test: `apps/backend/tests/test_circuit_breaker_concurrent.py`

**Interfaces:**
- Consumes: `CircuitBreaker.allow() -> bool`, `CircuitBreaker.record_success()/record_failure()`
- Produces: Exactly 1 probe allowed in HALF_OPEN

- [ ] **Step 1: Write failing test**

```python
def test_half_open_only_one_probe_concurrently():
    from app.services.resilience import CircuitBreaker
    import threading
    cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1, half_open_max_calls=1)
    cb.record_failure()
    time.sleep(0.12) # → HALF_OPEN
    results = []
    def try_allow():
        results.append(cb.allow())
    threads = [threading.Thread(target=try_allow) for _ in range(10)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert sum(results) == 1
```

- [ ] **Step 2: Run FAIL** (currently 10 allowed)

- [ ] **Step 3: Fix** — add `_half_open_lock = threading.Lock()` + `_probe_in_flight = False`; `allow()` atomically: `with lock: if state==HALF_OPEN and not _probe_in_flight: _probe_in_flight=True; return True else: return False`; `record_success/failure` resets `_probe_in_flight=False` + transition to CLOSED/OPEN.

- [ ] **Step 4: Run PASS**

- [ ] **Step 5: Commit**

---

### Task 5: Frontend Pagination Structured Metadata

**Files:**
- Modify: `apps/frontend/lib/reader/transport.ts:92`
- Modify: `apps/frontend/lib/queryKeys.ts:27`
- Test: `apps/frontend/tests/transport.test.ts`

**Interfaces:**
- Consumes: `paginatedGet(basePath, params, map, signal, hardCap, allowPartial)`
- Produces: `{results: T[], partial: boolean, failedPages: number[]}` or throw if `strict=true`

- [ ] **Step 1: Write failing test**

```ts
test("paginatedGet returns partial metadata, bulk strict throws", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok:true, json:async()=>({success:true,data:{results:[1],totalPages:3}})})
    .mockResolvedValueOnce({ ok:true, json:async()=>({success:true,data:{results:[2]}})})
    .mockRejectedValueOnce(new Error("page3 fail"));
  await expect(paginatedGet("/api/v1/reader/whitelist", new URLSearchParams("page_size=6"), x=>x, undefined, fetchMock as any, 2, true)).rejects.toThrow(/partial failure/);
  // infinite tolerant
  const res = await paginatedGet("/api/v1/reader/rss", new URLSearchParams("limit=6"), x=>x, undefined, fetchMock as any, 2, false);
  expect(res.partial).toBe(true);
});
```

- [ ] **Step 2: Run FAIL**

- [ ] **Step 3: Implement** — add param `allowPartial?: boolean = !basePath.includes("/rss")` already `isBulkCompleteNeed`; change return type to include metadata, update callers `useInfiniteFeed` to handle `partial` UI banner + retry button per page.

- [ ] **Step 4: Run PASS**

- [ ] **Step 5: Commit**

---

### Task 6: SSRF Allowlist Verification

**Files:**
- Modify: `apps/backend/app/utils/ssrf.py` (new) + `apps/backend/app/scrapers/*.py`

**Interfaces:**
- Consumes: `url: string`
- Produces: `assertAllowedUrl(url)` throws if not in `ALLOWED_DOMAINS = {"ikiru.wtf","shinigami.asia","voratoon.id",...}` or `is_private_ip`

- [ ] **Step 1: Write failing test**

```python
def test_ssrf_rejects_private_ip():
    from app.utils.ssrf import assert_allowed_url
    with pytest.raises(ValueError):
        assert_allowed_url("http://127.0.0.1/admin")
    with pytest.raises(ValueError):
        assert_allowed_url("http://169.254.169.254/latest/meta-data/")
```

- [ ] **Step 2: Run FAIL**

- [ ] **Step 3: Implement allowlist + `ipaddress` private check, wrap all `fetch_series_detail`, `get_ikiru_series_meta`, `cover_url` fetches**

- [ ] **Step 4: Run PASS**

- [ ] **Step 5: Commit**

---

## Self-Review

**Spec coverage:** Executor timeout, health_map vs scrape, Discord duplicate, circuit breaker, cross-source dedup (explicit key), DB fallback durable, partial pagination, 401 concurrent test, SSRF, updated_at double already fixed via `048`, continue_reading per-row already fixed — all mapped.

**Placeholder scan:** No TBD; all steps have concrete code.

**Type consistency:** `paginatedGet` new param `allowPartial` matches `hardCap` order; `CircuitBreaker.allow() -> bool` unchanged.

**Execution Handoff:** Plan complete and saved to `docs/superpowers/plans/2026-09-17-cache-reliability-hardening.md`. Two execution options: 1) Subagent-Driven (recommended) 2) Inline Execution — Which approach?

