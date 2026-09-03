"""Source collection: scrape ikiru + shinigami + voratoon, filter whitelist.

Canonical implementation — app/services/scraper_service.py now delegates here
(single source of truth, was duplicate 1092L vs 164L).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta

from app.config import settings
from app.logger import get_logger
from app.services.fcfs import parse_chapter_number as _parse_chapter_num
from app.services.rating_utils import normalize_rating
from app.scrapers.shinigami import _country_to_type as _country_to_type_fn

_TYPE_TO_ORIGIN = {"manhwa": "KR", "manhua": "CN", "manga": "JP"}

def _type_to_origin(type_str: str) -> str:
    """Derive origin from type when country_id not available."""
    t = (type_str or "").lower()
    return _TYPE_TO_ORIGIN.get(t, "")

def _origin_to_type(origin: str) -> str:
    """Fallback type from origin: KR->manhwa, CN->manhua, JP->manga."""
    o = (origin or "").upper()
    if o == "KR":
        return "manhwa"
    if o == "CN":
        return "manhua"
    if o == "JP":
        return "manga"
    return ""


from app.scrapers import ikiru, shinigami
from app.storage import health, whitelist as wl_store
from app.utils.text import normalize_title_key
from app.utils.cover_scrub import scrub_cover

logger = get_logger("cron:collect")

# alias used by collect_recent_chapters
health_store = health

# Max chapters we pull per series from the per-series chapter-list API.
MAX_CHAPTERS_PER_SERIES = 25

# In-memory cache for per-series chapter lists.
_CHAPTER_CACHE: dict[str, tuple[float, list]] = {}
_CHAPTER_CACHE_TTL = 300.0
_CHAPTER_CACHE_MAX = 512

# Short TTL cache for ikiru series metadata API.
_IKIRU_META_CACHE: dict[str, tuple[float, dict]] = {}
_IKIRU_META_CACHE_TTL = 21600.0
_IKIRU_META_CACHE_MAX = 512

# Short TTL cache for shinigami series metadata API.
_SHINIGAMI_META_CACHE: dict[str, tuple[float, dict]] = {}
_SHINIGAMI_META_CACHE_TTL = 21600.0
_SHINIGAMI_META_CACHE_MAX = 512

import time as _time_mod
import threading

_CHAPTER_CACHE_LOCK = threading.Lock()

_PARSE_TYPES_CACHE: dict[str, list[str]] = {}
_PARSE_TYPES_CACHE_MAX = 1024


def _cached_chapter_list(source: str, sid: str, fetcher) -> list:
    """Fetch a per-series chapter list with a short TTL cache + inter-fetch
    delay to avoid shinigami's per-series rate limit (429).

    Thread-safe: cache access is guarded by _CHAPTER_CACHE_LOCK so it can be
    called concurrently from the bounded collector pool (PERF-02).
    """
    key = f"{source}:{sid}"
    with _CHAPTER_CACHE_LOCK:
        cached = _CHAPTER_CACHE.get(key)
        if cached and (_time_mod.monotonic() - cached[0]) < _CHAPTER_CACHE_TTL:
            return cached[1]
    # Raised 0.25 -> 0.75s (2026-08-30): shinigami's public JSON API enforces a
    # strict per-IP rate limit and returns 429 on burst. With the bounded
    # collector pool this is the global floor between consecutive chapter-list
    # fetches across ALL workers, so a larger gap directly throttles throughput
    # and keeps us under the 429 threshold.
    _time_mod.sleep(0.75)
    data = fetcher() or []
    with _CHAPTER_CACHE_LOCK:
        _CHAPTER_CACHE[key] = (_time_mod.monotonic(), data)
        if len(_CHAPTER_CACHE) > _CHAPTER_CACHE_MAX:
            for _k in list(_CHAPTER_CACHE)[:len(_CHAPTER_CACHE) - _CHAPTER_CACHE_MAX]:
                _CHAPTER_CACHE.pop(_k, None)
    return data


def _cached_series_meta(source: str, sid: str, tk: str | None = None) -> dict:
    """Fetch per-series static metadata (rating, genres, description, cover, type).

    Lazy bootstrap against series_meta (the single source of truth):
    - If series_meta already has this (title_key, source) with a rating or
      description, return it WITHOUT hitting the upstream API (saves the
      ikiru Cloudflare 403 / shinigami 429 budget on every cron run).
    - If NOT present yet, fetch from the source API once and upsert into
      series_meta. This means a brand-new series picked up by any of the
      rss-fetch crons (ikiru/shinigami/voratoon, every 10 min) auto-populates
      its meta — no separate sync cron needed.

    In-memory TTL cache (per process) further avoids re-fetching within a run.
    """
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

    # 1) Already in series_meta? Use it, skip the upstream call entirely.
    _key = tk if tk else normalize_title_key(str(sid))
    try:
        from app.db import get_supabase as _gsb
        _existing = (
            _gsb().table("series_meta")
            .select("title_key, source, rating, genres, description, cover, type")
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
                with _CHAPTER_CACHE_LOCK:
                    cache[sid] = (now, _e)
                return _e
    except Exception:
        pass

    # 2) Not present → fetch from upstream (throttled) and persist.
    # Throttle upstream metadata calls: shinigami public API hard-rate-limits
    # (HTTP 429) on burst, and ikiru meta is HTML-scraped behind Cloudflare
    # (HTTP 403). A small inter-fetch delay keeps us under the threshold even
    # when many new series appear in one cron run. The lock serializes this
    # across the bounded collector pool so we don't fire N concurrent metas.
    # Kept short (0.3s) to avoid blowing the 30s collect budget on a busy run
    # while still smoothing bursts below the 429 ceiling.
    _time_mod.sleep(0.3)
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
    # Persist the per-series static data into series_meta (single source of
    # truth). Even an empty {} is cached in-memory to avoid re-fetching a
    # failed lookup, but we only upsert when we actually got data.
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
        except Exception:
            pass
    with _CHAPTER_CACHE_LOCK:
        cache[sid] = (now, meta)
        if len(cache) > mx:
            for _k in list(cache)[: len(cache) - mx]:
                cache.pop(_k, None)
    return meta


# Bounded concurrency for per-series chapter fetches (PERF-02). 5 workers is
# enough to parallelize I/O without triggering 429/Cloudflare on the sources.
_COLLECT_WORKERS = 12  # parallel per-series chapter fetches (PERF-05b)


def _ikiru_process_series(u: dict, latest_sent: dict[tuple[str, str], float], fetch_meta: bool = True) -> list[dict]:
    """Fetch + filter one ikiru series' recent chapters. Worker for the
    bounded collector pool — returns items to append (may be empty)."""
    items: list[dict] = []
    series_title = u.get("title", "")
    series_slug = u.get("slug") or ""
    series_url = u.get("permalink") or u.get("url") or ""
    series_cover = scrub_cover(u.get("cover"))
    origin = ""
    if not series_slug:
        return items
    _meta: dict = {}
    if fetch_meta:
        _meta = _cached_series_meta("ikiru", series_slug, tk=normalize_title_key(series_title))
    _meta_rating = normalize_rating(u.get("rating")) or normalize_rating(_meta.get("rating"))
    _meta_genres = u.get("genre") or _meta.get("genres") or []
    try:
        from app.scrapers import ikiru as _ikiru_scraper
        ch_list = _cached_chapter_list(
            "ikiru", series_slug,
            lambda: _ikiru_scraper.get_ikiru_chapters(series_slug),
        )
    except Exception as _e:
        logger.warn("ikiru chapter list failed", slug=series_slug, err=str(_e)[:120])
        return items
    _max_num, _max_num_time = _ikiru_re_touch_anchor(ch_list)
    for ch in ch_list[:MAX_CHAPTERS_PER_SERIES]:
        ch_str = str(ch.get("number") or ch.get("num") or "")
        ch_id = ch.get("id")
        chapter_url = ch.get("url") or (
            f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{series_slug}/chapter-{ch_str}.{ch_id}/"
            if ch_str and ch_id else ""
        )
        if not chapter_url:
            continue
        _chn = _parse_chapter_num(ch_str)
        _ut = ch.get("updated_time") or ""
        if not _ut:
            continue
        try:
            from datetime import datetime as _dt, timezone as _tz, timedelta as _td
            _dtp = _dt.fromisoformat(_ut.replace("Z", "+00:00"))
            if _dtp < (_dt.now(_tz.utc) - _td(hours=24)):
                continue
        except (ValueError, TypeError):
            continue
        if _is_ikiru_re_touch(_chn, _dtp, _max_num, _max_num_time):
            continue
        if _chn is not None and _max_num and _chn < _max_num:
            continue
        _ceil = latest_sent.get(
            (series_title, "ikiru"),
            latest_sent.get((normalize_title_key(series_title), "ikiru"), 0),
        )
        if _chn is not None and _ceil and _chn <= _ceil:
            continue
        items.append(
            {
                "title": series_title,
                "title_key": normalize_title_key(series_slug),
                "chapter": ch_str,
                "chapter_num": _parse_chapter_num(ch_str),
                "url": chapter_url,
                "source": "ikiru",
                "cover": series_cover,
                "series_url": series_url,
                "chapter_url": chapter_url,
                "origin": origin,
                "updated_time": _ut,
                "rating": _meta_rating,
                "genres": _meta_genres,
                "type": (u.get("type") or [""])[0].lower() if isinstance(u.get("type"), list) else (u.get("type") or "").lower(),
            }
        )
    return items


def _shinigami_process_series(m: dict, latest_sent: dict[tuple[str, str], float], fetch_meta: bool = True) -> list[dict]:
    """Fetch + filter one shinigami series' recent chapters. Worker for the
    bounded collector pool — returns items to append (may be empty)."""
    items: list[dict] = []
    title = m.get("title") or m.get("manga_name")
    manga_id = m.get("manga_id", "")
    if not manga_id:
        return items
    origin = (m.get("country_id") or "").upper()
    _meta: dict = {}
    if fetch_meta:
        _meta = _cached_series_meta("shinigami", manga_id, tk=normalize_title_key(title or ""))
    _meta_rating = normalize_rating(m.get("rating") or m.get("user_rate")) or normalize_rating(_meta.get("rating"))
    _meta_genres = (m.get("genre") or m.get("genres") or _meta.get("genres") or [])
    try:
        ch_list = _cached_chapter_list(
            "shinigami", manga_id,
            lambda: shinigami.get_shinigami_chapters(manga_id, per_page=MAX_CHAPTERS_PER_SERIES),
        )
    except Exception as _e:
        logger.warn("shinigami chapter list failed", manga_id=manga_id, err=str(_e)[:120])
        return items
    for ch in ch_list[:MAX_CHAPTERS_PER_SERIES]:
        ch_str = str(ch.get("chapter_number") or "")
        ch_id = ch.get("chapter_id") or ""
        chapter_url = f"https://11.shinigami.asia/chapter/{ch_id}" if ch_id else ""
        if not chapter_url:
            continue
        _rd = ch.get("release_date") or ""
        if _rd:
            try:
                from datetime import datetime as _dt, timezone as _tz, timedelta as _td
                _dtp = _dt.fromisoformat(_rd.replace("Z", "+00:00"))
                if _dtp < (_dt.now(_tz.utc) - _td(hours=24)):
                    continue
            except (ValueError, TypeError):
                pass
        _chn = _parse_chapter_num(ch_str)
        _ceil = latest_sent.get(
            (str(title or ""), "shinigami"),
            latest_sent.get((normalize_title_key(title or ""), "shinigami"), 0),
        )
        if _chn is not None and _ceil and _chn <= _ceil:
            continue
        items.append(
            {
                "title": title,
                "title_key": normalize_title_key(title or ""),
                "chapter": ch_str,
                "chapter_num": _parse_chapter_num(ch_str),
                "url": chapter_url,
                "source": "shinigami",
                "cover": m.get("cover_image_url") or m.get("cover"),
                "series_url": f"https://11.shinigami.asia/series/{manga_id}" if manga_id else "",
                "chapter_url": chapter_url,
                "origin": origin,
                "updated_time": _rd or m.get("latest_chapter_time") or m.get("updated_time", ""),
                "rating": _meta_rating,
                "genres": _meta_genres,
                "type": _country_to_type_fn(m.get("country_id")) or "",
                }
        )
    return items


# Per-source timeout budget (PERF-05): if a source is down and retries are
# dragging, don't let it hold the whole pipeline. Mark degraded + skip after
# this many seconds so the other source still runs. Retries inside the
# scrapers are preserved — we just cap total wall-clock per source.
#
# ikiru's "latest updates" feed re-checks ~100 series every run (each chapter
# fetch ~0.23s, parallelized at _COLLECT_WORKERS=5) → ~28s wall-clock. The
# old 30s cap was too tight: variance (429 retries, slow upstream) pushed it
# over and the thread was killed mid-run, DISCARDING all ikiru items (same
# class of bug as shinigami's old collector). 60s is safely above ikiru's
# real runtime and well within the 10-min cron interval. shinigami is now
# list-based (~0.5s) so it's unaffected.
_SOURCE_TIMEOUT = 180.0


def _collect_ikiru_source(latest_sent: dict, disabled: set, fetch_meta: bool = True, exclude_keys: set[str] | None = None) -> list[dict]:
    """Collect all ikiru recent chapters.
    
    If `exclude_keys` is provided (normalized title_keys from shinigami/voratoon),
    skip any series whose normalized title is in that set — ikiru becomes a
    gap-filler, not a duplicate scanner.
    """
    from app.scrapers import ikiru as _ikiru_scraper
    from concurrent.futures import ThreadPoolExecutor
    items: list[dict] = []
    _series = list(_ikiru_scraper.get_ikiru_latest_updates())
    if not _series:
        return items
    
    # Pre-filter: drop series already covered by other sources
    if exclude_keys:
        _series = [
            u for u in _series
            if normalize_title_key(u.get("title", "")) not in exclude_keys
        ]
        if not _series:
            return items
    
    with ThreadPoolExecutor(max_workers=_COLLECT_WORKERS) as _ex:
        _futs = [_ex.submit(_ikiru_process_series, u, latest_sent, fetch_meta) for u in _series]
        for _f in _futs:
            try:
                items.extend(_f.result() or [])
            except Exception as _fe:
                logger.warn("ikiru series worker failed", err=str(_fe)[:120])
    return items


def _collect_shinigami_source(latest_sent: dict, disabled: set, fetch_meta: bool = True) -> list[dict]:
    """Collect shinigami recent chapters from the latest-updates LIST only.

    FIX (2026-08-30): previously this deep-fetched every series' chapter list +
    metadata via _shinigami_process_series — serial, 0.75s inter-fetch delay,
    ~1000 series -> ~15min, which blew past _SOURCE_TIMEOUT=30s. On timeout the
    partial `items` was DISCARDED, so shinigami persisted 0 rows every run.

    The latest-updates list response already carries everything RSS needs per
    series: `chapters[]` (chapter_id + chapter_number + created_at),
    `latest_chapter_time`, `user_rate` (rating), `cover_image_url`, `country_id`
    (origin), `latest_chapter_id`. So we build rows directly from the list —
    no per-series fetch. This mirrors how voratoon.collect_voratoon() works and
    finishes in seconds, well under the 30s budget.

    Per-series detail (full chapter history / taxonomy) is still lazily fetched
    for WHITELISTED series only (see _enrich_whitelisted_shinigami), not during
    the hot RSS scrape path.
    """
    from app.scrapers import shinigami as _shinigami_scraper
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td

    items: list[dict] = []
    _series: list[dict] = []
    try:
        _series.extend(_shinigami_scraper.get_shinigami_latest_updates() or [])
    except Exception as _pe:
        logger.warn("shinigami latest fetch failed", err=str(_pe)[:120])
        return items

    _now = _dt.now(_tz.utc)
    _cutoff = _now - _td(hours=24)
    for m in _series:
        manga_id = m.get("manga_id", "")
        if not manga_id:
            continue
        title = m.get("title") or m.get("manga_name") or ""
        if not title:
            continue
        tk = manga_id  # use API manga_id as the stable key (not normalized title)
        origin = (m.get("country_id") or "").upper()
        cover = m.get("cover_image_url") or m.get("cover_portrait_url") or ""
        # Rating is in the list (user_rate); normalize 1-10 like the scraper does.
        rating = normalize_rating(m.get("user_rate"))
        # Description (synopsis) + genres live in the list too — copy them so
        # the RSS/Discord embed shows a blurb (previously empty: only the
        # per-series enrich path filled description, which we now skip in
        # fetch mode, leaving most shinigami rows without one).
        description = (m.get("description") or "").strip()
        _tax = m.get("taxonomy") or {}
        if isinstance(_tax, dict):
            genres = [g.get("name") for g in (_tax.get("Genre") or []) if g.get("name")]
        elif isinstance(_tax, list):
            genres = [t for t in _tax if isinstance(t, str)]
        else:
            genres = []
        series_url = f"https://11.shinigami.asia/series/{manga_id}"
        chaps = m.get("chapters") or []
        for ch in chaps:
            ch_id = ch.get("chapter_id") or ""
            if not ch_id:
                continue
            ch_str = str(ch.get("chapter_number") or "")
            _rd = ch.get("created_at") or m.get("latest_chapter_time") or ""
            if _rd:
                try:
                    _dtp = _dt.fromisoformat(_rd.replace("Z", "+00:00"))
                    if _dtp.tzinfo is None:
                        _dtp = _dtp.replace(tzinfo=_tz.utc)
                    # Only keep chapters within the 24h RSS window.
                    if _dtp < _cutoff:
                        continue
                except (ValueError, TypeError):
                    pass
            chapter_url = f"https://11.shinigami.asia/chapter/{ch_id}"
            _chn = _parse_chapter_num(ch_str)
            _ceil = latest_sent.get((tk, "shinigami"), 0)
            if _chn is not None and _ceil and _chn <= _ceil:
                continue
            items.append(
                {
                    "title": title,
                    "title_key": tk,
                    "chapter": ch_str,
                    "chapter_num": _chn,
                    "url": chapter_url,
                    "source": "shinigami",
                    "cover": cover,
                    "series_url": series_url,
                    "chapter_url": chapter_url,
                    "origin": origin,
                    "updated_time": _rd or m.get("latest_chapter_time") or m.get("updated_at", ""),
                    "rating": rating,
                    "genres": genres,
                    "description": description,
                    "type": _country_to_type_fn(m.get("country_id")) or "",
                }
            )
    return items


    """Delegate to centralized FCFS parser (app/services/fcfs.py)."""
    from app.services.fcfs import parse_chapter_number as _pcn

    return _pcn(ch)


def _ikiru_re_touch_anchor(chapters: list[dict]) -> tuple[float, datetime | None]:
    """Monotonic anchor for ikiru re-touch detection."""
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


def _is_ikiru_re_touch(num: float | None, ts, max_num: float, max_time) -> bool:
    """True if a lower-numbered chapter claims a NEWER timestamp than the
    series' highest chapter — ikiru's signature for re-uploading an old chapter."""
    if max_time is None or num is None:
        return False
    try:
        return num < max_num and ts > max_time
    except TypeError:
        return False


def _parse_types(raw) -> list[str]:
    """Normalize ikiru `type` which may be a list OR a stringified list."""
    cache_key = (str(raw) if raw is not None else "")
    try:
        return _PARSE_TYPES_CACHE[cache_key]
    except KeyError:
        pass
    import ast
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


def collect_recent_chapters(
    with_whitelisted_ikiru: bool = False,
    with_whitelisted_shinigami: bool = False,
    source: str | None = None,
    fetch_meta: bool = True,
) -> tuple[list[dict], dict]:
    """Fetch latest from sources.

    If `source` is set ("ikiru", "shinigami", or "voratoon"), only that source is scraped.
    Otherwise, both sources are scraped (default).
    """
    _disabled: set[str] = set()
    # Permanent source disable via env (comma-separated). Lets ops disable a
    # source without code changes, e.g. DISABLED_SOURCES=ikiru.
    _env_disabled = (getattr(settings, "DISABLED_SOURCES", "") or "").strip()
    if _env_disabled:
        for _s in _env_disabled.split(","):
            _s = _s.strip().lower()
            if _s:
                _disabled.add(_s)
    try:
        from datetime import datetime, timezone
        hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
        _now = datetime.now(timezone.utc)
        for src, row in (hm or {}).items():
            du = row.get("disabled_until")
            if du:
                try:
                    if datetime.fromisoformat(du.replace("Z", "+00:00")) > _now:
                        _disabled.add(src)
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass

    items: list[dict] = []
    import time as _t
    _hm: dict[str, dict] = {}
    _now_iso = datetime.now(timezone.utc).isoformat()

    _latest_sent: dict[tuple[str, str], float] = {}
    try:
        from app.db import get_supabase as _gsb_ls
        _wl_ls = _gsb_ls().table("whitelist").select("title_key, source, latest_sent_chapter").execute()
        for _w in (_wl_ls.data or []):
            _tk = _w.get("title_key") or ""
            _src = _w.get("source") or ""
            try:
                _ls = float(_w.get("latest_sent_chapter") or 0)
            except (ValueError, TypeError):
                _ls = 0
            _latest_sent[(_tk, _src)] = max(_latest_sent.get((_tk, _src), 0), _ls)
    except Exception as _e:
        logger.warn("collect: load latest_sent_chapter failed", err=str(_e)[:160])

    def _health_start(src: str) -> float:
        return _t.time()

    def _health_end(src: str, t0: float, ok: bool, err: str | None = None) -> None:
        rt = int((_t.time() - t0) * 1000)
        prev = _hm.get(src) or {}
        consec = prev.get("consecutive_failures", 0)
        consec = 0 if ok else consec + 1
        _hm[src] = {
            "status": "healthy" if ok else "degraded",
            "response_time_ms": rt,
            "successes_today": (prev.get("successes_today", 0) + 1) if ok else prev.get("successes_today", 0),
            "failures_today": (prev.get("failures_today", 0) + 1) if not ok else prev.get("failures_today", 0),
            "consecutive_failures": consec,
            "last_success_at": _now_iso if ok else prev.get("last_success_at"),
            "last_checked_at": _now_iso,
            "last_error": err if not ok else None,
        }



    # Source collection — concurrent with per-source timeout and failover.
    # All sources run in parallel; a failure in one doesn't block the others.
    import concurrent.futures

    def _try_collect(src: str) -> tuple[str, list[dict]]:
        """Collect from a single source, return (source, items)."""
        try:
            _src_items: list[dict] = []
            if src == "ikiru":
                _exclude_keys: set[str] = set()
                for _it in items:
                    _tk = _it.get("title_key", "") or _it.get("title", "")
                    if _tk:
                        _exclude_keys.add(normalize_title_key(_tk))
                _src_items = _collect_ikiru_source(_latest_sent, _disabled, fetch_meta, exclude_keys=_exclude_keys)
            elif src == "shinigami":
                _src_items = _collect_shinigami_source(_latest_sent, _disabled, fetch_meta)
            elif src == "voratoon":
                from app.scrapers import voratoon as _voratoon_scraper
                for u in _voratoon_scraper.collect_voratoon():
                    series_title = u.get("title", "")
                    series_slug = u.get("title_key") or ""
                    series_url = u.get("series_url") or ""
                    series_cover = u.get("cover") or ""
                    origin = u.get("origin") or "KR"
                    if not series_slug:
                        continue
                    ch_str = u.get("chapter") or ""
                    ch_id = u.get("chapter_url") or ""
                    chapter_url = ch_id
                    if not chapter_url:
                        continue
                    _chn = _parse_chapter_num(ch_str)
                    _ut = u.get("updated_time") or ""
                    if not _ut:
                        continue
                    try:
                        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
                        _dtp = _dt.fromisoformat(_ut.replace("Z", "+00:00"))
                        if _dtp < (_dt.now(_tz.utc) - _td(hours=24)):
                            continue
                    except (ValueError, TypeError):
                        continue
                    _ceil = _latest_sent.get(
                        (str(series_title or ""), "voratoon"),
                        _latest_sent.get(
                            (normalize_title_key(series_title or ""), "voratoon"), 0
                        ),
                    )
                    if _chn is not None and _ceil and _chn <= _ceil:
                        continue
                    _src_items.append({
                        "title": series_title,
                        "title_key": normalize_title_key(series_slug),
                        "chapter": ch_str,
                        "chapter_num": _parse_chapter_num(ch_str),
                        "url": chapter_url,
                        "source": "voratoon",
                        "cover": series_cover,
                        "series_url": series_url,
                        "chapter_url": chapter_url,
                        "origin": origin,
                        "updated_time": _ut,
                        "description": u.get("description") or "",
                        "genres": u.get("genres") or [],
                        "rating": normalize_rating(u.get("rating")),
                        "type": u.get("type") or "",
                    })
            return (src, _src_items)
        except Exception as e:
            return (src, [])

    _sources_to_run: list[str] = []
    for _src in ("ikiru", "shinigami", "voratoon"):
        if (source is None or source == _src) and _src not in _disabled:
            _sources_to_run.append(_src)

    if _sources_to_run:
        _t0_map: dict[str, float] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(_sources_to_run)) as _executor:
            _futures: dict = {}
            for _src in _sources_to_run:
                _t0_map[_src] = _health_start(_src)
                logger.info("collect start", source=_src)
                _futures[_executor.submit(_try_collect, _src)] = _src
            for _future in concurrent.futures.as_completed(_futures, timeout=_SOURCE_TIMEOUT):
                _src = _futures[_future]
                _t0 = _t0_map.get(_src, _health_start(_src))
                try:
                    _collected_src, _src_items = _future.result(timeout=5)
                    items.extend(_src_items)
                    _health_end(_src, _t0, True)
                    rt_ms = int((_t.time() - _t0) * 1000)
                    logger.info("collect done", source=_src, count=len(_src_items), response_time_ms=rt_ms)
                except concurrent.futures.TimeoutError:
                    _health_end(_src, _t0, False, f"timeout after {_SOURCE_TIMEOUT}s")
                    logger.warn("collect TIMEOUT", source=_src, timeout=_SOURCE_TIMEOUT)
                except Exception as e:
                    _health_end(_src, _t0, False, str(e)[:300])
                    logger.warn("collect failed", source=_src, err=str(e)[:200])
    else:
        for _src in ("ikiru", "shinigami", "voratoon"):
            _hm[_src] = {
                "status": "disabled",
                "response_time_ms": 0,
                "successes_today": 0,
                "failures_today": 0,
                "consecutive_failures": 0,
                "last_success_at": None,
                "last_checked_at": _now_iso,
                "last_error": "cooldown",
            }

    # Whitelisted ikiru titles
    if with_whitelisted_ikiru and "ikiru" not in _disabled:
        try:
            wl = wl_store.load_whitelist()
            items.extend(collect_whitelisted_ikiru_chapters(wl))
        except Exception as e:
            logger.warn("collect whitelisted ikiru failed", err=str(e))

    # Whitelisted shinigami titles
    if with_whitelisted_shinigami and "shinigami" not in _disabled:
        try:
            wl = wl_store.load_whitelist()
            items.extend(collect_whitelisted_shinigami_chapters(wl))
        except Exception as e:
            logger.warn("collect whitelisted shinigami failed", err=str(e))

    # Drop excluded titles
    try:
        from app.storage import excluded_titles as excl_store
        from app.utils.text import normalize_title_key as _ntk_c
        _excl = excl_store.load_excluded_keys()
        if _excl:
            _before = len(items)
            items = [
                it for it in items
                if not (
                    (tk := _ntk_c(it.get("title_key", "") or it.get("title", "")))
                    and ((tk, (it.get("source") or "all")) in _excl or (tk, "all") in _excl)
                )
            ]
            _dropped = _before - len(items)
            if _dropped:
                logger.info("collect: dropped excluded titles", count=_dropped)
    except Exception as e:
        logger.warn("collect: exclude filter failed", err=str(e)[:200])

    return items, _hm


def filter_whitelisted(items: list[dict], whitelist: list[dict]) -> list[dict]:
    """Keep only items whose title_key matches a whitelisted source entry."""
    allowed: set[str] = set()
    for w in whitelist:
        wk = normalize_title_key(w.get("title_key", ""))
        src = w.get("source")
        if src:
            allowed.add(f"{wk}:{src}")
    result = []
    for it in items:
        key = f"{normalize_title_key(it.get('title_key', ''))}:{it.get('source')}"
        if key in allowed:
            result.append(it)
    return result


def _ikiru_slug_from_source(src: dict) -> str | None:
    """Best-effort ikiru slug from a whitelist source entry."""
    v = src.get("url") or ""
    if v:
        seg = v.rstrip("/").split("/")[-1]
        if seg and "chapter-" not in seg:
            return seg
    p = src.get("permalink") or src.get("series_url") or ""
    if p and "/manga/" in p:
        part = p.split("/manga/")[-1].strip("/")
        if part and "chapter-" not in part:
            return part.split("/")[0]
    return None


def collect_whitelisted_shinigami_chapters(whitelist: list[dict]) -> list[dict]:
    """HTML-scrape chapters for whitelisted shinigami titles."""
    import random
    ids: list[tuple[str, str, str]] = []
    seen_ids: set[str] = set()
    from app.db import get_supabase as _get_sb
    _sb = _get_sb()
    for w in whitelist:
        wk = normalize_title_key(w.get("title_key", ""))
        src = w.get("source")
        if src != "shinigami":
            continue
        v = w.get("url") or w.get("series_url") or w.get("permalink") or ""
        mid = None
        if 'shinigami.asia/' in v:
            seg = v.rstrip('/').split('/')[-1]
            if seg and '-' in seg:
                mid = seg
        if not mid:
            try:
                rc = (
                    _sb.table("recent_chapters")
                    .select("series_url")
                    .eq("title_key", w.get("title_key", ""))
                    .eq("source", "shinigami")
                    .neq("series_url", "")
                    .limit(1)
                    .execute()
                )
                if rc.data:
                    su = rc.data[0].get("series_url") or ""
                    if "shinigami.asia/series/" in su:
                        mid = su.rstrip("/").split("/")[-1]
            except Exception:
                pass
        if not mid:
            continue
        if mid in seen_ids:
            continue
        seen_ids.add(mid)
        ids.append((mid, wk, w.get("title") or wk.replace("_", " ").title()))

    items: list[dict] = []
    API_CHAPTER_LIMIT = 30
    _notified: dict[str, set[float]] = {}
    try:
        from app.db import get_supabase as _gsb2
        _sb2 = _gsb2()
        _wk_list = [wk for _, wk, _ in ids]
        if _wk_list:
            _dh = (
                _sb2.table("dispatch_history")
                .select("title_key, source, chapter_title")
                .in_("title_key", _wk_list)
                .execute()
            )
            for _row in (_dh.data or []):
                _tk = _row.get("title_key")
                _src = _row.get("source")
                _ct = _row.get("chapter_title")
                try:
                    _cn = float(_ct)
                except (ValueError, TypeError):
                    continue
                _notified.setdefault(f"{_tk}:{_src}", set()).add(_cn)
    except Exception as _e:
        logger.warn("shinigami notified-history load failed", err=str(_e)[:120])
    for mid, wk, wtitle in ids:
        chapters = None
        for _att in range(5):
            try:
                chapters = shinigami.get_shinigami_chapters(mid, per_page=API_CHAPTER_LIMIT)
                break
            except Exception as e:
                import time as _bt
                if _att < 4:
                    _sleep = min(2.0 * (_att + 1), 10.0) + random.uniform(0, 1.0)
                    _bt.sleep(_sleep)
                    continue
                logger.warn("whitelisted shinigami api scrape failed", mid=mid, err=str(e)[:120])
        if not chapters:
            continue
        series_url = f"https://11.shinigami.asia/series/{mid}"
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        _sent = _notified.get(f"{wk}:shinigami") or set()
        for idx, ch in enumerate(chapters):
            num = ch.get("chapter_number") or ch.get("number") or ch.get("chapter")
            ch_id = ch.get("chapter_id") or ch.get("id")
            ch_url = f"https://11.shinigami.asia/chapter/{ch_id}" if ch_id else (ch.get("url") or "")
            if not ch_url or num is None:
                continue
            rel_raw = ch.get("release_date") or ch.get("published_at") or ch.get("created_at")
            rel_iso = None
            if rel_raw:
                try:
                    rel_iso = datetime.fromisoformat(str(rel_raw).replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    rel_iso = None
            if rel_iso is None or rel_iso < cutoff:
                continue
            try:
                _num_f = float(num)
            except (ValueError, TypeError):
                _num_f = 0
            if _num_f > 0 and _num_f in _sent:
                continue
            items.append({
                "title": (wtitle or wk.replace("_", " ").title()).replace("’", "'"),
                "title_key": wk,
                "chapter": str(num),
                "chapter_num": float(num) if str(num).replace(".", "", 1).isdigit() else 0,
                "url": ch_url,
                "source": "shinigami",
                "cover": None,
                "series_url": series_url,
                "chapter_url": ch_url,
                "origin": "",
                "updated_time": rel_iso.isoformat(),
            })
    return items


def collect_whitelisted_ikiru_chapters(whitelist: list[dict]) -> list[dict]:
    """HTML-scrape chapters for whitelisted ikiru titles."""
    slugs: list[str] = []
    seen_slugs: set[str] = set()
    slug_meta = {}
    for w in whitelist:
        src = w.get("source")
        if src != "ikiru":
            continue
        from app.utils.text import ikiru_slug as _ikiru_slug
        _src_url = w.get("url") or w.get("series_url") or w.get("permalink") or ""
        slug = _ikiru_slug_from_source({"url": _src_url}) or _ikiru_slug(w.get("title") or w.get("title_key") or "")
        if not slug and w.get("title"):
            try:
                from app.scrapers.ikiru import search_ikiru_api
                _hits = search_ikiru_api(str(w.get("title")), per_page=5)
                for _h in _hits:
                    _perm = _h.get("permalink") or ""
                    if "/manga/" in _perm:
                        slug = _perm.split("/manga/")[-1].strip("/").split("/")[0]
                        try:
                            from app.db import get_supabase
                            get_supabase().table("whitelist").update({"series_url": _perm}).eq(
                                "title_key", w.get("title_key")
                            ).eq("source", "ikiru").execute()
                        except Exception:
                            pass
                        break
            except Exception:
                pass
        if slug in seen_slugs:
            continue
        if not slug:
            continue
        seen_slugs.add(slug)
        slugs.append(slug)
        slug_meta[slug] = {
            "title": w.get("title") or w.get("title_key", "").replace("-", " ").title(),
            "origin": w.get("origin") or "",
            "cover": w.get("cover") or None,
            # Snapshot ceiling: highest chapter WE have already notified for
            # this series. Monotonic + reliable — ikiru's live API can return a
            # truncated/flaky chapter list, but our own record never lies.
            "latest_sent_chapter": float(w.get("latest_sent_chapter") or 0),
        }

    items: list[dict] = []
    HTML_CHAPTER_LIMIT = 30
    _now = datetime.now(timezone.utc)
    _cutoff = _now - timedelta(hours=24)
    _slug_notified: dict[str, set[float]] = {}
    try:
        from app.db import get_supabase as _gsb3
        _sb3 = _gsb3()
        _tk_list = [normalize_title_key(s.replace("-", " ")) for s in slugs]
        if _tk_list:
            _dh = (
                _sb3.table("dispatch_history")
                .select("title_key, source, chapter_title")
                .in_("title_key", _tk_list)
                .execute()
            )
            for _row in (_dh.data or []):
                _tk = _row.get("title_key")
                _src = _row.get("source")
                _ct = _row.get("chapter_title")
                try:
                    _cn = float(_ct)
                except (ValueError, TypeError):
                    continue
                _slug_notified.setdefault(f"{_tk}:{_src}", set()).add(_cn)
    except Exception as _e:
        logger.warn("ikiru notified-history load failed", err=str(_e)[:120])
    for slug in slugs:
        _tk = normalize_title_key(slug.replace("-", " "))
        _sent = _slug_notified.get(f"{_tk}:ikiru") or set()
        chapters = _cached_chapter_list(
            "ikiru",
            slug,
            lambda: ikiru.get_ikiru_chapters(slug),
        )
        if not chapters:
            continue
        _max_num, _max_num_time = _ikiru_re_touch_anchor(chapters)
        if len(chapters) > HTML_CHAPTER_LIMIT:
            chapters = chapters[:HTML_CHAPTER_LIMIT]
        series_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/"
        meta = slug_meta.get(slug, {})
        title = meta.get("title") or slug.replace("-", " ").title()
        origin = meta.get("origin") or ""
        cover = meta.get("cover") or None
        # Ceiling = max(our snapshot, live API). Snapshot (latest_sent_chapter)
        # is authoritative — if ikiru's live list is truncated/flaky, the
        # snapshot still blocks old re-touched chapters. Live max only seeds
        # first-run so a brand-new series doesn't get spammed with stale chapters.
        _snapshot_max = float(meta.get("latest_sent_chapter") or 0)
        _max_num = max(_max_num, _snapshot_max)

        for ch in chapters:
            num = ch.get("number")
            try:
                _num_f = float(num) if num is not None else None
            except (ValueError, TypeError):
                _num_f = None
            ch_url = ch.get("url")
            if not ch_url or _num_f is None:
                continue
            if _num_f in _sent:
                continue
            _ut = ch.get("updated_time") or ""
            if not _ut:
                continue
            try:
                _dtp = datetime.fromisoformat(_ut.replace("Z", "+00:00"))
                if _dtp.tzinfo is None:
                    _dtp = _dtp.replace(tzinfo=timezone.utc)
                if _is_ikiru_re_touch(_num_f, _dtp, _max_num, _max_num_time):
                    continue
                # Hard ceiling: only the latest (or newer) chapter may notify.
                # ikiru re-touches old chapters; number-based ceiling is robust
                # against timestamp leaks when the latest chapter is bumped too.
                if _num_f < _max_num:
                    continue
                if _dtp < _cutoff:
                    break
            except (ValueError, TypeError):
                continue
            items.append(
                {
                    "title": title,
                    "title_key": (ch_url.rstrip("/").split("/")[-2] if ch_url else "").lower() or normalize_title_key(title),
                    "chapter": str(num),
                    "chapter_num": _num_f,
                    "url": ch_url,
                    "source": "ikiru",
                    "cover": cover,
                    "series_url": series_url,
                    "chapter_url": ch_url,
                    "origin": origin,
                    "updated_time": _ut,
                }
            )
    return items