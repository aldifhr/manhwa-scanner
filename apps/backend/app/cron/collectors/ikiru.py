"""Ikiru per-series collector — extracted from collect.py:202."""
from app.config import settings
from app.logger import get_logger
from app.services.rating_utils import normalize_rating
from app.utils.text import normalize_title_key
from app.utils.cover_scrub import scrub_cover
from app.cron.collectors.common import _cached_chapter_list, _cached_series_meta, MAX_CHAPTERS_PER_SERIES, _COLLECT_WORKERS, logger as _common_logger
from app.services.fcfs import parse_chapter_number as _parse_chapter_num
from app.cron.collectors.common import _ikiru_re_touch_anchor, _is_ikiru_re_touch

logger = get_logger("cron:collect:ikiru")


def _ikiru_process_series(u: dict, latest_sent: dict[tuple[str, str], float], fetch_meta: bool = True) -> list[dict]:
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
        ch_list = _cached_chapter_list("ikiru", series_slug, lambda: _ikiru_scraper.get_ikiru_chapters(series_slug))
    except Exception as _e:
        logger.warn("ikiru chapter list failed", slug=series_slug, err=str(_e)[:120])
        return items
    _max_num, _max_num_time = _ikiru_re_touch_anchor(ch_list)
    for ch in ch_list[:MAX_CHAPTERS_PER_SERIES]:
        ch_str = str(ch.get("number") or ch.get("num") or "")
        ch_id = ch.get("id")
        chapter_url = ch.get("url") or (f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{series_slug}/chapter-{ch_str}.{ch_id}/" if ch_str and ch_id else "")
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
        _ceil = latest_sent.get((series_title, "ikiru"), latest_sent.get((normalize_title_key(series_title), "ikiru"), 0))
        if _chn is not None and _ceil and _chn <= _ceil:
            continue
        items.append({"title": series_title, "title_key": normalize_title_key(series_slug), "chapter": ch_str, "chapter_num": _parse_chapter_num(ch_str), "url": chapter_url, "source": "ikiru", "cover": series_cover, "series_url": series_url, "chapter_url": chapter_url, "origin": origin, "updated_time": _ut, "rating": _meta_rating, "genres": _meta_genres, "type": (u.get("type") or [""])[0].lower() if isinstance(u.get("type"), list) else (u.get("type") or "").lower()})
    return items


def _collect_ikiru_source(latest_sent: dict, disabled: set, fetch_meta: bool = True, exclude_keys: set[str] | None = None) -> list[dict]:
    from app.scrapers import ikiru as _ikiru_scraper
    from concurrent.futures import ThreadPoolExecutor
    from app.cron.collectors.common import _COLLECT_WORKERS
    from app.utils.text import normalize_title_key as _ntk
    items: list[dict] = []
    _series = list(_ikiru_scraper.get_ikiru_latest_updates())
    if not _series:
        return items
    if exclude_keys:
        _series = [u for u in _series if _ntk(u.get("title", "")) not in exclude_keys]
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
