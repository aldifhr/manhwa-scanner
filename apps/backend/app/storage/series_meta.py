"""SeriesMeta deep module — hides 6h TTL + Redis + DB + upstream."""
from __future__ import annotations

import threading
import time as _time_mod

from app.cron.collectors.common import _is_series_meta_stale, _SERIES_META_TTL_S

# Redis mirror helpers (copied from common.py, seam-owned)
def _redis() -> object | None:
    try:
        from app.config import settings as _s

        if not getattr(_s, "REDIS_URL", ""):
            return None
        import redis  # type: ignore

        return redis.Redis.from_url(_s.REDIS_URL, decode_responses=True, socket_connect_timeout=0.2, socket_timeout=0.2)
    except Exception:
        return None


def _redis_get_meta(source: str, sid: str) -> dict | None:
    try:
        _r = _redis()
        if not _r:
            return None
        raw = _r.get(f"series_meta:{source}:{sid}")
        if not raw:
            return None
        import json as _js

        data = _js.loads(raw) if isinstance(raw, str) else raw
        if _is_series_meta_stale(data.get("updated_at")):
            return None
        return data
    except Exception:
        return None


def _redis_set_meta(source: str, sid: str, meta: dict) -> None:
    try:
        _r = _redis()
        if not _r:
            return
        import json as _js

        _r.setex(f"series_meta:{source}:{sid}", int(_SERIES_META_TTL_S), _js.dumps(meta))
    except Exception:
        pass


class SeriesMeta:
    """Seam hiding in-mem LRU 512 + Redis setex 6h + DB series_meta + upstream + stale fallback."""

    def __init__(self, db=None, fetcher=None, redis_url=None):
        self._db = db
        self._fetcher = fetcher
        self._redis_url = redis_url
        self._cache: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()
        self._max = 512

    def _get_db(self):
        if self._db is not None:
            return self._db
        try:
            from app.db import get_supabase

            return get_supabase()
        except Exception:
            return None

    def _fetcher_call(self, source: str, sid: str) -> dict:
        if self._fetcher is not None:
            try:
                return self._fetcher(source, sid) or {}
            except Exception:
                return {}
        try:
            if source == "ikiru":
                from app.scrapers import ikiru as _ik

                return _ik.get_ikiru_series_meta(sid) or {}
            elif source == "shinigami":
                from app.scrapers import shinigami as _sh

                return _sh.get_shinigami_series_meta(sid) or {}
        except Exception:
            pass
        return {}

    def get(self, source: str, sid: str) -> dict:
        if source not in ("ikiru", "shinigami"):
            return {}
        cache_key = f"{source}:{sid}"
        now = _time_mod.monotonic()

        # in-mem hit
        with self._lock:
            c = self._cache.get(cache_key)
            if c and (now - c[0]) < _SERIES_META_TTL_S:
                return c[1]

        # Redis cross-worker
        _rm = _redis_get_meta(source, sid)
        if _rm is not None:
            with self._lock:
                self._cache[cache_key] = (now, _rm)
                if len(self._cache) > self._max:
                    for _k in list(self._cache)[: len(self._cache) - self._max]:
                        self._cache.pop(_k, None)
            return _rm

        _stale_row: dict | None = None
        db = self._get_db()
        if db is not None:
            try:
                rows = (
                    db.table("series_meta")
                    .select("title_key, source, rating, genres, description, cover, type, origin, updated_at")
                    .eq("title_key", sid)
                    .eq("source", source)
                    .limit(1)
                    .execute()
                    .data
                    or []
                )
                if rows:
                    e = rows[0]
                    if (e.get("rating") not in (None, "", 0)) or (e.get("description") or "").strip():
                        if not _is_series_meta_stale(e.get("updated_at")):
                            with self._lock:
                                self._cache[cache_key] = (now, e)
                                if len(self._cache) > self._max:
                                    for _k in list(self._cache)[: len(self._cache) - self._max]:
                                        self._cache.pop(_k, None)
                            _redis_set_meta(source, sid, e)
                            return e
                        _stale_row = e
            except Exception:
                pass

        # upstream refresh (only if not fresh DB)
        meta = self._fetcher_call(source, sid)
        if meta:
            # try upsert
            try:
                if db is not None:
                    row = {
                        "title_key": sid,
                        "source": source,
                        "rating": meta.get("rating"),
                        "genres": meta.get("genres") or [],
                        "description": meta.get("description") or "",
                        "cover": meta.get("cover"),
                        "type": meta.get("type"),
                        "origin": meta.get("origin") or "",
                        "updated_at": "now()",
                    }
                    db.table("series_meta").upsert(row, on_conflict="title_key,source").execute()
            except Exception:
                pass
            with self._lock:
                self._cache[cache_key] = (now, meta)
                if len(self._cache) > self._max:
                    for _k in list(self._cache)[: len(self._cache) - self._max]:
                        self._cache.pop(_k, None)
            _redis_set_meta(source, sid, meta)
            return meta

        if _stale_row is not None:
            with self._lock:
                self._cache[cache_key] = (now, _stale_row)
                if len(self._cache) > self._max:
                    for _k in list(self._cache)[: len(self._cache) - self._max]:
                        self._cache.pop(_k, None)
            _redis_set_meta(source, sid, _stale_row)
            return _stale_row

        with self._lock:
            self._cache[cache_key] = (now, {})
            if len(self._cache) > self._max:
                for _k in list(self._cache)[: len(self._cache) - self._max]:
                    self._cache.pop(_k, None)
        return {}

    def get_bulk(self, keys: list[tuple[str, str]]) -> dict[tuple[str, str], dict]:
        result: dict[tuple[str, str], dict] = {}
        for sid, source in keys:
            result[(sid, source)] = self.get(source, sid)
        return result

    def invalidate(self, source: str, sid: str) -> None:
        cache_key = f"{source}:{sid}"
        with self._lock:
            self._cache.pop(cache_key, None)
        try:
            _r = _redis()
            if _r:
                _r.delete(f"series_meta:{source}:{sid}")
        except Exception:
            pass


series_meta = SeriesMeta()
