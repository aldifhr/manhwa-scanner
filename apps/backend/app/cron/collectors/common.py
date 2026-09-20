"""Shared caches + helpers for per-source collectors."""
from __future__ import annotations

import re
import time as _time_mod
import threading

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
