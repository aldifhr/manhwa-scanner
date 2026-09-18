"""Shared caches + helpers for per-source collectors."""
from __future__ import annotations

import re
import time as _time_mod
import threading

from app.config import settings
from app.logger import get_logger

logger = get_logger("cron:collect:common")


def _origin_to_type(origin: str) -> str:
    o = (origin or "").upper()
    if o == "KR":
        return "manhwa"
    if o == "CN":
        return "manhua"
    if o == "JP":
        return "manga"
    return ""


MAX_CHAPTERS_PER_SERIES = 25

_CHAPTER_CACHE: dict[str, tuple[float, list]] = {}
_CHAPTER_CACHE_TTL = 300.0
_CHAPTER_CACHE_MAX = 512

_IKIRU_META_CACHE: dict[str, tuple[float, dict]] = {}
_IKIRU_META_CACHE_TTL = 21600.0  # 6h — sama dengan DB TTL di bawah
_IKIRU_META_CACHE_MAX = 512

_SHINIGAMI_META_CACHE: dict[str, tuple[float, dict]] = {}
_SHINIGAMI_META_CACHE_TTL = 21600.0  # 6h
_SHINIGAMI_META_CACHE_MAX = 512

# ponytail P1: series_meta sebagai SSoT lazy — tanpa TTL bisa stale selamanya.
# Policy: <6h pakai cache/DB, >=6h refresh upstream, gagal → stale cache (cover/rating 6-24h wajar)
_SERIES_META_TTL_S = 6 * 3600  # 6h (cover/rating/genre boleh 6-24h)


def _is_series_meta_stale(updated_at: str | None) -> bool:
    if not updated_at:
        return True
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(str(updated_at).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - dt).total_seconds()
        return age >= _SERIES_META_TTL_S
    except Exception:
        return True

_CHAPTER_CACHE_LOCK = threading.Lock()

_PARSE_TYPES_CACHE: dict[str, list[str]] = {}
_PARSE_TYPES_CACHE_MAX = 1024

_COLLECT_WORKERS = 12
_SOURCE_TIMEOUT = 120.0


def _cached_chapter_list(source: str, sid: str, fetcher) -> list:
    key = f"{source}:{sid}"
    with _CHAPTER_CACHE_LOCK:
        cached = _CHAPTER_CACHE.get(key)
        if cached and (_time_mod.monotonic() - cached[0]) < _CHAPTER_CACHE_TTL:
            return cached[1]
    try:
        data = fetcher() or []
    except Exception as e:
        err_str = str(e).lower()
        if "429" in err_str or "500" in err_str or "503" in err_str:
            _time_mod.sleep(0.5)
            data = fetcher() or []
        else:
            data = []
    with _CHAPTER_CACHE_LOCK:
        _CHAPTER_CACHE[key] = (_time_mod.monotonic(), data)
        if len(_CHAPTER_CACHE) > _CHAPTER_CACHE_MAX:
            for _k in list(_CHAPTER_CACHE)[:len(_CHAPTER_CACHE) - _CHAPTER_CACHE_MAX]:
                _CHAPTER_CACHE.pop(_k, None)
    return data


def preload_series_meta_bulk(keys: list[tuple[str, str]]) -> None:
    """ponytail: 1 query for 150 series vs 150 queries — warm both caches"""
    if not keys:
        return
    # dedupe, group by source
    from collections import defaultdict
    by_src: dict[str, set[str]] = defaultdict(set)
    for tk, src in keys:
        if src in ("ikiru", "shinigami") and tk:
            by_src[src].add(tk)
    for src, tks in by_src.items():
        cache, ttl, mx = (
            (_IKIRU_META_CACHE, _IKIRU_META_CACHE_TTL, _IKIRU_META_CACHE_MAX)
            if src == "ikiru"
            else (_SHINIGAMI_META_CACHE, _SHINIGAMI_META_CACHE_TTL, _SHINIGAMI_META_CACHE_MAX)
        )
        # filter not cached
        now = _time_mod.monotonic()
        need = [tk for tk in tks if not (cache.get(tk) and (now - cache[tk][0]) < ttl)]
        if not need:
            continue
        try:
            from app.db import get_supabase as _gsb2
            # chunk 100 (PostgREST IN limit)
            for i in range(0, len(need), 100):
                chunk = need[i:i+100]
                rows = (
                    _gsb2().table("series_meta")
                    .select("title_key, source, rating, genres, description, cover, type, origin, updated_at")
                    .in_("title_key", chunk)
                    .eq("source", src)
                    .execute()
                    .data
                    or []
                )
                for r in rows:
                    tk = r.get("title_key")
                    if tk and (r.get("rating") not in (None, "", 0) or (r.get("description") or "").strip()):
                        # ponytail P1: jangan warm stale row — biarkan _cached_series_meta refresh (6h TTL)
                        if _is_series_meta_stale(r.get("updated_at")):
                            continue
                        # use tk as sid key for cache (both sid and tk forms)
                        with _CHAPTER_CACHE_LOCK:
                            cache[tk] = (now, r)
        except Exception:
            pass

def _cached_series_meta(source: str, sid: str) -> dict:
    if source not in ("ikiru", "shinigami"):
        return {}
    cache, ttl, mx = (
        (_IKIRU_META_CACHE, _IKIRU_META_CACHE_TTL, _IKIRU_META_CACHE_MAX)
        if source == "ikiru"
        else (_SHINIGAMI_META_CACHE, _SHINIGAMI_META_CACHE_TTL, _SHINIGAMI_META_CACHE_MAX)
    )
    now = _time_mod.monotonic()
    with _CHAPTER_CACHE_LOCK:
        c = cache.get(sid)
        if c and (now - c[0]) < ttl:
            return c[1]
    _key = sid
    _stale_db_row: dict | None = None
    try:
        from app.db import get_supabase as _gsb
        _existing = (
            _gsb().table("series_meta")
            .select("title_key, source, rating, genres, description, cover, type, origin, updated_at")
            .eq("title_key", _key)
            .eq("source", source)
            .limit(1)
            .execute()
            .data
            or []
        )
        if _existing:
            _e = _existing[0]
            if (_e.get("rating") not in (None, "", 0)) or (_e.get("description") or "").strip():
                # ponytail P1: DB TTL 6h — jika fresh (<6h) langsung pakai, jika stale coba refresh
                if not _is_series_meta_stale(_e.get("updated_at")):
                    with _CHAPTER_CACHE_LOCK:
                        cache[sid] = (now, _e)
                    return _e
                # stale → simpan untuk fallback jika refresh gagal
                _stale_db_row = _e
    except Exception:
        pass
    meta: dict = {}
    try:
        if source == "ikiru":
            from app.scrapers import ikiru as _ik
            meta = _ik.get_ikiru_series_meta(sid) or {}
        elif source == "shinigami":
            from app.scrapers import shinigami as _sh
            meta = _sh.get_shinigami_series_meta(sid) or {}
    except Exception:
        pass
    if meta:
        try:
            _sb = _gsb()
            _row = {
                "title_key": _key,
                "source": source,
                "rating": meta.get("rating"),
                "genres": meta.get("genres") or [],
                "description": meta.get("description") or "",
                "cover": meta.get("cover"),
                "type": meta.get("type"),
                "origin": meta.get("origin") or "",
                "updated_at": "now()",
            }
            _sb.table("series_meta").upsert(_row, on_conflict="title_key,source").execute()
            # Invalidate memory cache so next read gets fresh data
            cache.pop(sid, None)
            # Cache fresh upstream result (reset TTL)
            with _CHAPTER_CACHE_LOCK:
                cache[sid] = (now, meta)
                if len(cache) > mx:
                    for _k in list(cache)[: len(cache) - mx]:
                        cache.pop(_k, None)
            return meta
        except Exception:
            pass
        # Upsert gagal → fallback ke upstream meta tanpa DB persistance
        with _CHAPTER_CACHE_LOCK:
            cache[sid] = (now, meta)
            if len(cache) > mx:
                for _k in list(cache)[: len(cache) - mx]:
                    cache.pop(_k, None)
        return meta
    # Refresh gagal atau tidak ada upstream meta → fallback stale DB jika ada
    if _stale_db_row is not None:
        with _CHAPTER_CACHE_LOCK:
            cache[sid] = (now, _stale_db_row)
            if len(cache) > mx:
                for _k in list(cache)[: len(cache) - mx]:
                    cache.pop(_k, None)
        return _stale_db_row
    # Tidak ada DB dan upstream gagal → cache empty
    with _CHAPTER_CACHE_LOCK:
        cache[sid] = (now, meta)
        if len(cache) > mx:
            for _k in list(cache)[: len(cache) - mx]:
                cache.pop(_k, None)
    return meta


def _ikiru_re_touch_anchor(chapters: list[dict]) -> tuple[float, "datetime | None"]:
    _max_num = 0.0
    for c in chapters:
        try:
            n = float(c.get("number") or 0)
        except (ValueError, TypeError):
            continue
        if n > _max_num:
            _max_num = n
    _max_time = None
    for c in chapters:
        try:
            if float(c.get("number") or 0) == _max_num:
                _mt = c.get("updated_time") or ""
                if _mt:
                    from datetime import datetime as _dt, timezone as _tz
                    _max_time = _dt.fromisoformat(_mt.replace("Z", "+00:00"))
                    if _max_time.tzinfo is None:
                        _max_time = _max_time.replace(tzinfo=_tz.utc)
                break
        except (ValueError, TypeError):
            continue
    return _max_num, _max_time


def _is_ikiru_re_touch(num, ts, max_num: float, max_time) -> bool:
    if max_time is None or num is None:
        return False
    try:
        return num < max_num and ts > max_time
    except TypeError:
        return False


def _parse_types(raw) -> list[str]:
    import ast
    cache_key = (str(raw) if raw is not None else "")
    try:
        return _PARSE_TYPES_CACHE[cache_key]
    except KeyError:
        pass
    if raw is None:
        result = []
    elif isinstance(raw, list):
        result = [str(x).lower() for x in raw if x]
    else:
        s = str(raw).strip()
        if s.startswith("[") and s.endswith("]"):
            try:
                parsed = ast.literal_eval(s)
                if isinstance(parsed, (list, tuple)):
                    result = [str(x).lower() for x in parsed if x]
                else:
                    result = []
            except Exception:
                result = []
        else:
            result = [p.strip().lower() for p in re.split(r"[,\s]+", s) if p.strip()]
    _PARSE_TYPES_CACHE[cache_key] = result
    if len(_PARSE_TYPES_CACHE) > _PARSE_TYPES_CACHE_MAX:
        for _k in list(_PARSE_TYPES_CACHE)[:len(_PARSE_TYPES_CACHE) - _PARSE_TYPES_CACHE_MAX]:
            _PARSE_TYPES_CACHE.pop(_k, None)
    return result
