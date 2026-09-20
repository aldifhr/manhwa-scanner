# SeriesMeta Deep Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen `collectors/common.py` shallow caches into `SeriesMeta` seam `app/storage/series_meta.py` with 6h Redis mirror, pilot `shinigami`.

**Architecture:** New `SeriesMeta` class hides `in-mem LRU 512 + Redis setex 6h + DB series_meta select + upstream ikiru/shinigami + stale fallback` behind `get`/`get_bulk`/`invalidate`; `common.py` becomes thin re-export. Inject `db`/`fetcher` for testability.

**Tech Stack:** Python 3.14, psycopg2, redis-py, pydantic, pytest, `common.py` TTL 6h, `MAX 512`

**Spec:** `docs/superpowers/specs/2026-09-20-seriesmeta-design.md`

## Global Constraints
- Single TTL 6h (`_SERIES_META_TTL_S = 21600`) for ikiru+shinigami
- Redis `series_meta:{source}:{sid}` setex 6h, fallback debug (not warn) when down
- In-mem `512` LRU, thread-safe via `_CHAPTER_CACHE_LOCK`
- Interface `get(source,sid)->dict` is test surface
- Pilot `shinigami` first, then 4 callers
- No new deps, copy spec values verbatim

---

### Task 1: Create SeriesMeta module with failing test

**Files:**
- Create: `apps/backend/app/storage/series_meta.py`
- Create: `apps/backend/tests/test_series_meta.py`
- Modify: `apps/backend/app/cron/collectors/common.py:1-10` (add import for re-export later, not yet)

**Interfaces:**
- Consumes: `app.config.settings.REDIS_URL`, `app.db.get_supabase`, `app.scrapers.ikiru.get_ikiru_series_meta`, `app.scrapers.shinigami.get_shinigami_series_meta`
- Produces: `class SeriesMeta` with `get(source,sid)->dict`, `get_bulk(keys)->dict`, `invalidate(source,sid)->None`, `instance series_meta = SeriesMeta()`

- [ ] **Step 1: Write the failing test**

```python
# apps/backend/tests/test_series_meta.py
import os
os.environ['ENVIRONMENT']='development'
def test_series_meta_hit_and_stale():
    from unittest.mock import MagicMock, patch
    from app.storage.series_meta import SeriesMeta
    fresh = {"title_key":"t","source":"ikiru","rating":8.5,"genres":["A"],"description":"d","cover":"","type":"","origin":"KR","updated_at": __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
    mock_db = MagicMock()
    mock_table = MagicMock()
    mock_db.table.return_value = mock_table
    mock_table.select.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.limit.return_value = mock_table
    mock_table.execute.return_value = MagicMock(data=[fresh])
    sm = SeriesMeta(db=mock_db, fetcher=lambda s, sid: {})
    with patch("app.storage.series_meta._redis_get_meta", return_value=None):
        r1 = sm.get("ikiru","t")
        assert r1.get("rating")==8.5
        # second hit should not call DB again
        r2 = sm.get("ikiru","t")
        assert mock_db.table.call_count == 4  # select*eq*limit*execute once
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py::test_series_meta_hit_and_stale -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.storage.series_meta'`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/backend/app/storage/series_meta.py
"""SeriesMeta deep module — hides 6h TTL + Redis + DB + upstream."""
from __future__ import annotations
import time as _time_mod, threading
from app.cron.collectors.common import _is_series_meta_stale, _SERIES_META_TTL_S
# copy _redis, _redis_get_meta, _redis_set_meta from common.py (or import)
class SeriesMeta:
    def __init__(self, db=None, fetcher=None):
        self._db = db
        self._fetcher = fetcher
        self._cache = {}
        self._lock = threading.Lock()
    def get(self, source, sid): ...
    def get_bulk(self, keys): ...
    def invalidate(self, source, sid): ...
series_meta = SeriesMeta()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py::test_series_meta_hit_and_stale -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/app/storage/series_meta.py apps/backend/tests/test_series_meta.py
git commit -m "feat: add SeriesMeta seam with in-mem + Redis 6h"
```

### Task 2: Implement get with Redis/DB/upstream + stale fallback

**Files:**
- Modify: `apps/backend/app/storage/series_meta.py:20-80`
- Test: `apps/backend/tests/test_series_meta.py` (add 2 tests)

**Interfaces:**
- Consumes: `SeriesMeta.get` from Task 1
- Produces: full `get` logic with `in-mem 512 LRU + Redis setex 6h + DB fresh + stale fallback + upstream`

- [ ] **Step 1: Write the failing tests**

```python
def test_series_meta_redis_hit():
    # mock _redis_get_meta returns fresh, DB should not be called
    ...

def test_series_meta_stale_fallback():
    # DB returns stale 2020 row, upstream returns fresh 9.0, should upsert and return 9.0
    ...
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py -k redis -v`
Expected: FAIL (NotImplemented)

- [ ] **Step 3: Write minimal implementation**

Copy logic from `common.py:167-260` into `SeriesMeta.get`: in-mem check, `_redis_get_meta`, DB `series_meta` select, stale check, upstream `get_ikiru_series_meta`/`get_shinigami_series_meta`, `upsert`, `setex`, `cache` + `lock`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/app/storage/series_meta.py apps/backend/tests/test_series_meta.py
git commit -m "feat: implement SeriesMeta.get with Redis/DB/upstream stale fallback"
```

### Task 3: Implement get_bulk + invalidate + migrate common.py re-export

**Files:**
- Modify: `apps/backend/app/storage/series_meta.py:80-120` (add get_bulk, invalidate)
- Modify: `apps/backend/app/cron/collectors/common.py:83-127` (replace bodies with `from app.storage.series_meta import series_meta` re-export)
- Test: `apps/backend/tests/test_series_meta.py` (add bulk test)

**Interfaces:**
- Consumes: `SeriesMeta.get` from Task 2
- Produces: `get_bulk(keys)` + `common._cached_series_meta` still works via re-export

- [ ] **Step 1: Write the failing test**

```python
def test_get_bulk_and_invalidate():
    sm = SeriesMeta(db=mock_db)
    sm.get_bulk([("t1","ikiru"),("t2","shinigami")])
    assert len(sm._cache)>=2
    sm.invalidate("ikiru","t1")
    assert "t1" not in sm._cache
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py::test_get_bulk_and_invalidate -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Implement `get_bulk` by looping `get` (or bulk `in_ 100`), `invalidate` pops in-mem + `redis.delete`.

Modify `common.py`: `def _cached_series_meta(...): return series_meta.get(source,sid)` and `def preload_series_meta_bulk(keys): return series_meta.get_bulk(keys)`

- [ ] **Step 4: Run tests to verify they pass**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_series_meta.py -v`
Expected: PASS (4 tests)
Run: `py -m pytest -o addopts="" apps/backend/tests/test_services.py apps/backend/tests/test_storage_health.py -v`
Expected: PASS (25/26, 1 pre-existing)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/app/storage/series_meta.py apps/backend/app/cron/collectors/common.py apps/backend/tests/test_series_meta.py
git commit -m "feat: add SeriesMeta.get_bulk/invalidate + re-export common"
```

### Task 4: Pilot shinigami collector to SeriesMeta

**Files:**
- Modify: `apps/backend/app/cron/collectors/shinigami.py:6` (import series_meta)
- Modify: `apps/backend/app/cron/collectors/shinigami.py:44-50` (replace `_cached_series_meta` call with `series_meta.get`)
- Test: `apps/backend/tests/test_shinigami_contract.py` (existing) + manual live check 138

**Interfaces:**
- Consumes: `SeriesMeta.get` from Task 3
- Produces: `shinigami` collector now uses seam, no direct `common` DB

- [ ] **Step 1: Write the failing test (mocked collector)**

```python
def test_shinigami_uses_series_meta_seam():
    from unittest.mock import patch
    with patch("app.storage.series_meta.series_meta.get", return_value={"rating":9.0}) as m:
        from app.cron.collectors.shinigami import _collect_shinigami_source
        # call with mocked get_shinigami_latest_updates
        ...
        assert m.called
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_shinigami_collector.py -v`
Expected: FAIL (not using seam)

- [ ] **Step 3: Write minimal implementation**

Replace `from app.cron.collectors.common import _cached_series_meta` with `from app.storage.series_meta import series_meta` and `series_meta.get("shinigami", tk)`

- [ ] **Step 4: Run tests to verify they pass**

Run: `py -m pytest -o addopts="" apps/backend/tests/test_shinigami_contract.py -v`
Expected: PASS
Run: `npm run build` → BUILD OK

- [ ] **Step 5: Commit**

```bash
git add apps/backend/app/cron/collectors/shinigami.py
git commit -m "refactor: pilot shinigami to SeriesMeta seam"
```

