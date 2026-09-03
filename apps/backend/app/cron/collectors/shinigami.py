"""Shinigami per-series collector — extracted from collect.py:279."""
from app.logger import get_logger
from app.services.rating_utils import normalize_rating
from app.utils.text import normalize_title_key
from app.scrapers.shinigami import _country_to_type as _country_to_type_fn
from app.cron.collectors.common import _cached_chapter_list, _cached_series_meta, MAX_CHAPTERS_PER_SERIES
from app.services.fcfs import parse_chapter_number as _parse_chapter_num

logger = get_logger("cron:collect:shinigami")


def _shinigami_process_series(m: dict, latest_sent: dict[tuple[str, str], float], fetch_meta: bool = True) -> list[dict]:
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
        from app.scrapers import shinigami as shinigami
        ch_list = _cached_chapter_list("shinigami", manga_id, lambda: shinigami.get_shinigami_chapters(manga_id, per_page=MAX_CHAPTERS_PER_SERIES))
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
        _ceil = latest_sent.get((str(title or ""), "shinigami"), latest_sent.get((normalize_title_key(title or ""), "shinigami"), 0))
        if _chn is not None and _ceil and _chn <= _ceil:
            continue
        items.append({"title": title, "title_key": normalize_title_key(title or ""), "chapter": ch_str, "chapter_num": _parse_chapter_num(ch_str), "url": chapter_url, "source": "shinigami", "cover": m.get("cover_image_url") or m.get("cover"), "series_url": f"https://11.shinigami.asia/series/{manga_id}" if manga_id else "", "chapter_url": chapter_url, "origin": origin, "updated_time": _rd or m.get("latest_chapter_time") or m.get("updated_time", ""), "rating": _meta_rating, "genres": _meta_genres, "type": _country_to_type_fn(m.get("country_id")) or ""})
    return items


def _collect_shinigami_source(latest_sent: dict, disabled: set, fetch_meta: bool = True) -> list[dict]:
    from app.scrapers import shinigami as _shinigami_scraper
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    from app.services.rating_utils import normalize_rating as _nr
    from app.scrapers.shinigami import _country_to_type as _ctt
    from app.utils.text import normalize_title_key as _ntk
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
        tk = manga_id
        origin = (m.get("country_id") or "").upper()
        cover = m.get("cover_image_url") or m.get("cover_portrait_url") or ""
        rating = _nr(m.get("user_rate"))
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
                    if _dtp < _cutoff:
                        continue
                except (ValueError, TypeError):
                    pass
            chapter_url = f"https://11.shinigami.asia/chapter/{ch_id}"
            _chn = _parse_chapter_num(ch_str)
            _ceil = latest_sent.get((tk, "shinigami"), 0)
            if _chn is not None and _ceil and _chn <= _ceil:
                continue
            items.append({"title": title, "title_key": tk, "chapter": ch_str, "chapter_num": _chn, "url": chapter_url, "source": "shinigami", "cover": cover, "series_url": series_url, "chapter_url": chapter_url, "origin": origin, "updated_time": _rd or m.get("latest_chapter_time") or m.get("updated_at", ""), "rating": rating, "genres": genres, "description": description, "type": _ctt(m.get("country_id")) or ""})
    return items
