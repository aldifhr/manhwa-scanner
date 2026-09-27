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
