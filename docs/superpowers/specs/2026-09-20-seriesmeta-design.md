# SeriesMeta Deep Module — Design Spec
Date: 2026-09-20
Status: Approved (grill 01)
Scope: Architectural — deepen `collectors/common.py` shallow caches into `SeriesMeta` seam

## 1. Problem
`common.py` 334L is shallow: 4 caches (`_CHAPTER_CACHE`, `_IKIRU_META`, `_SHINIGAMI_META`, `_PARSE`) + Redis bolt-on, interface ` _cached_series_meta(source,sid)` leaks TTL 6h, lock, Redis, DB, upstream `ikiru/shinigami`, stale fallback. Deletion test: delete `common.py` → complexity scatters to 3 collectors (`shinigami.py`, `ikiru.py`, `voratoon` cover) + `enrich/resync.py` + `voratoon cover`. No locality — bug in Redis fallback needs 3 collector mocks to test.

Hot spot: 4 commits in 48h, 5 call sites, `pool closed` + `stale 6h` bugs hid here.

## 2. Solution — SeriesMeta seam
Create `app/storage/series_meta.py` with class `SeriesMeta`:

```python
class SeriesMeta:
    def __init__(self, db=None, fetcher=None, redis_url=None): # inject for test
    def get(self, source: str, sid: str) -> dict: # hide TTL/lock/Redis/DB/API
    def get_bulk(self, keys: list[tuple[str,str]]) -> dict[tuple[str,str], dict]:
    def invalidate(self, source: str, sid: str) -> None:
```

Internals (hidden): `in-mem LRU 512 + Redis setex 6h + DB select + upstream ikiru/shinigami + stale fallback`. Caller: `meta = series_meta.get("shinigami", tk)` — no TTL knob.

`common.py` becomes thin re-export: `from app.storage.series_meta import series_meta as _cached_series_meta` for backward compat, then delete after callers migrate.

## 3. Decisions (grill 01-08)
- Q1 Class vs func → Class `get`/`get_bulk`/`invalidate` (fake for test)
- Q2 Hide all (TTL/lock/Redis/DB/API) vs expose TTL → Hide all, single TTL
- Q3 Scope series_meta only (chapter_cache stays) → YAGNI
- Q4 Single TTL 6h (not per-source) → YAGNI
- Q5 Redis fallback `debug` (not warn) when down
- Q6 Inject `db`/`fetcher` via `__init__` (default real) → test surface = interface
- Q7 Location `app/storage/series_meta.py` (not `common.py`)
- Q8 Pilot `shinigami` first, then 4 others

## 4. Benefits
- **Locality:** Redis fallback bug now caught by one `SeriesMeta` test with fake Redis, not 3 collector mocks.
- **Leverage:** 1 seam → 5 callers (`shinigami`, `ikiru`, `voratoon cover`, `enrich-resync`, `preload_bulk`) share one TTL 6h.
- **Deletion test:** delete `SeriesMeta` → need re-implement (concentrates), not scatter.

## 5. Testing
- Unit: `SeriesMeta` with `fake_db` + `fake_redis` + `fake_fetcher` — hit/miss/stale/Redis-down paths, no live DB/API.
- Integration: pilot `shinigami` collector with `fake SeriesMeta` — no DB.
- Existing `test_services.py`, `test_storage_health.py` still pass; `test_shinigami_contract` unchanged.

## 6. Rollout
1. Create `series_meta.py` + `SeriesMeta` + tests
2. Migrate `collectors/shinigami.py` to `series_meta.get` (pilot)
3. Migrate `ikiru`, `enrich/resync`, `voratoon cover`, `preload_bulk`
4. Deprecate `common._cached_series_meta` → re-export, then delete

## 7. Risks
- Redis `setex` 6h must match in-mem TTL 6h — keep constant `_SERIES_META_TTL_S` single source.
- `updated_at` string vs `now()` — keep `_is_series_meta_stale` logic inside seam.

