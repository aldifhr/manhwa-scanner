"""Shinigami per-series collector."""
from app.config import settings
from app.logger import get_logger
from app.services.rating_utils import normalize_rating
from app.utils.text import slugify_title_key
from app.scrapers.shinigami import _country_to_type as _country_to_type_fn
from app.cron.collectors.common import _cached_chapter_list, _cached_series_meta, MAX_CHAPTERS_PER_SERIES
from app.services.fcfs import parse_chapter_number as _parse_chapter_num

logger = get_logger("cron:collect:shinigami")


def _shinigami_process_series(m: dict, latest_sent: dict[tuple[str, str], float], fetch_meta: bool = True) -> list[dict]:
    items: list[dict] = []
    title = (m.get("title") or m.get("manga_name") or "").replace("�", "'").replace("�", "'")
    manga_id = m.get("manga_id", "")
    if not manga_id:
        return items
    origin = (m.get("country_id") or "").upper()
    _meta: dict = {}
    if fetch_meta:
        _meta = _cached_series_meta("shinigami", slugify_title_key(title or ""))
    _meta_rating = _meta.get("rating") if _meta.get("rating") not in (None, "", 0) else (normalize_rating(m.get("rating") or m.get("user_rate")) or 0.0)
    _meta_desc = _meta.get("description") or ""
    _meta_genres = _meta.get("genres") or []
    try:
        from app.scrapers import shinigami as shinigami
        ch_list = _cached_chapter_list("shinigami", manga_id, lambda: shinigami.get_shinigami_chapters(manga_id, per_page=MAX_CHAPTERS_PER_SERIES))
    except Exception as _e:
        logger.warn("shinigami chapter list failed", manga_id=manga_id, err=str(_e)[:120])
        return items
    for ch in ch_list[:MAX_CHAPTERS_PER_SERIES]:
        ch_str = str(ch.get("chapter_number") or "")
        ch_id = ch.get("chapter_id") or ""
        chapter_url = f"{settings.SHINIGAMI_PUBLIC_BASE}/chapter/{ch_id}" if ch_id else ""
        if not chapter_url:
            continue
        _chn = _parse_chapter_num(ch_str)
        _ceil = latest_sent.get((slugify_title_key(title or ""), "shinigami"), 0)
        if _chn is not None and _ceil and _chn <= _ceil:
            continue
        _type = _country_to_type_fn(m.get("country_id")) or ""
        if origin == "CN":
            _type = "manhua"
        elif origin == "KR":
            _type = "manhwa"
        if not _type and isinstance(_meta, dict):
            _type = (_meta.get("type") or "").lower()
        items.append({"title": title, "title_key": slugify_title_key(title or ""), "chapter": ch_str, "chapter_num": _parse_chapter_num(ch_str), "url": chapter_url, "source": "shinigami", "cover": m.get("cover_image_url") or m.get("cover"), "series_url": f"{settings.SHINIGAMI_PUBLIC_BASE}/series/{manga_id}" if manga_id else "", "chapter_url": chapter_url, "origin": origin, "updated_time": ch.get("release_date") or m.get("latest_chapter_time") or m.get("updated_time", ""), "release_date": ch.get("release_date") or "", "rating": _meta_rating, "description": _meta_desc, "genres": _meta_genres, "type": _type})
    return items


def _collect_shinigami_source(latest_sent: dict, disabled: set, fetch_meta: bool = True) -> list[dict]:
    from app.scrapers import shinigami as _shinigami_scraper
    from app.utils.text import slugify_title_key as _ntk
    from app.services.scanner_confidence import attach_confidence
    items: list[dict] = []
    _series: list[dict] = []
    try:
        _series.extend(_shinigami_scraper.get_shinigami_latest_updates() or [])
    except Exception as _pe:
        logger.warn("shinigami latest fetch failed", err=str(_pe)[:120])
        return items
    for m in _series:
        items.extend(_shinigami_process_series(m, latest_sent, fetch_meta))
    return attach_confidence(items, "shinigami")
