# Final Fix Report — SeriesMeta (2026-09-20)

**Branch:** head
**Commit:** fix: address final review SeriesMeta DRY + bulk
**Review source:** `.superpowers/sdd/2026-09-20-seriesmeta/final-review.md` (F-1..F-6)
**Date:** 2026-09-20

## Fixes applied (single wave)

### [Important] F-1 — redis_url dead param → wired
- `apps/backend/app/storage/series_meta.py:56-60` `SeriesMeta.__init__(..., redis_url)` now stored and used.
- `app/storage/series_meta.py:20-58` `_redis(redis_url=None)`, `_redis_get_meta(..., redis_url)`, `_redis_set_meta(..., redis_url)` accept optional override.
- `SeriesMeta._redis_get`, `_redis_set`, `_redis_client` helpers prefer `self._redis_url` when set, else `settings.REDIS_URL`.
- Verification: `test_series_meta.py` injects via `patch("app.storage.series_meta._redis...")` still works; injectable via constructor now functional (debug path). No dead store.

### [Important] F-2 — DRY duplicate _redis helpers → single source
- Canonical helpers moved to `app/storage/series_meta.py` (TTL + stale + redis). `apps/backend/app/cron/collectors/common.py:25-38` removed local definitions (41-77, 79-91) and now re-exports via `from app.storage.series_meta import _SERIES_META_TTL_S, _is_series_meta_stale, _redis, _redis_get_meta, _redis_set_meta` (common.py:25-31).
- `series_meta.py` no longer imports from `common.py` → no circular import. TTL stays single source `series_meta.py:9` (`6*3600`), verified `py_compile` OK.
- Impact: future TTL/lock/debug changes only in `series_meta.py`.

### [Important] F-3 — get_bulk N+1 → bulk IN 100 dedupe/group
- `apps/backend/app/storage/series_meta.py:188-288` `SeriesMeta.get_bulk` rewritten:
  - early `if not keys: return {}` guard
  - `dict.fromkeys` dedupe, `defaultdict(group by source)` like old `common.py:122-166`
  - filter in-mem (`self._cache` + TTL) and Redis hits before DB
  - chunk 100 `in_("title_key", chunk).eq("source", src)` via `self._get_db()`; fresh rows cached + `setex`; stale/missing delegated to `self.get` (handles upstream + stale fallback).
  - MagicMock guard for existing tests: `rows` MagicMock → `[]` then fallback to per-key `get` so `test_get_bulk_and_invalidate` (mock with `.eq` chain, no `.in_` wiring) still passes (2 keys → bulk empty → fallback gives rating 8.5).
  - For 138 keys (voratoon note `13089→138`) now 2 DB roundtrips vs 138; pilot shinigami unaffected (per-item `get`), but `ikiru.py:77-78` `preload_series_meta_bulk` benefits.
- Design note kept in docstring: bulk fast path + per-key fallback preserves spec stale policy.

### [Minor] F-4/F-5 — preload return None vs {}, empty guard
- `common.py:52-57` `preload_series_meta_bulk` now `-> dict[tuple[str,str], dict]` (removed `| None`), `if not keys: return {}` and `series_meta.get_bulk` same guard. Type hint aligned, `ikiru.py` caller ignores return so no break.

### [Minor] F-6 — silent Redis fallback → debug log
- `series_meta.py:23-26, 43-46, 55-58` except blocks now `logger.debug("redis unavailable...")` / `"redis get/set fallback"` with `err` context, satisfying spec §3 Q5 "debug not warn" and retaining fallback to in-mem/db.

## Pilot shinigami still working
- `app/cron/collectors/shinigami.py:7,46` unchanged (`from app.storage.series_meta import series_meta`, `series_meta.get("shinigami", tk)`).
- Test: `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py apps/backend/tests/test_shinigami_collector.py -v` → **5 passed**
- Contracts: `test_shinigami_contract.py` → **3 passed**

## Verification
- `py -m py_compile apps/backend/app/storage/series_meta.py apps/backend/app/cron/collectors/common.py` → OK
- `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py apps/backend/tests/test_shinigami_collector.py -v` → 5 passed
- `py -m pytest -o addopts="" apps/backend/tests/test_services.py apps/backend/tests/test_storage_health.py -v` → 22 passed, 1 failed pre-existing (`test_fcfs_key` on base `d0f9686`, verified stash)
- `py -m pytest -o addopts="" apps/backend/tests/test_shinigami_contract.py -v` → 3 passed

## Files changed
- `apps/backend/app/storage/series_meta.py` — single source TTL/stale/redis + wired redis_url + bulk IN 100 + debug logs
- `apps/backend/app/cron/collectors/common.py` — DRY re-export from series_meta, type fix, empty guard
