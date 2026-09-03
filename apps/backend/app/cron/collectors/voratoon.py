"""Voratoon collector — extracted from collect.py inline voratoon loop."""
from app.services.rating_utils import normalize_rating
from app.utils.text import normalize_title_key
from app.services.fcfs import parse_chapter_number as _parse_chapter_num


def _collect_voratoon_source(latest_sent: dict) -> list[dict]:
    from app.scrapers import voratoon as _voratoon_scraper
    items: list[dict] = []
    for u in _voratoon_scraper.collect_voratoon():
        series_title = u.get("title", "")
        series_slug = u.get("title_key") or ""
        series_url = u.get("series_url") or ""
        series_cover = u.get("cover") or ""
        origin = u.get("origin") or "KR"
        if not series_slug:
            continue
        ch_str = u.get("chapter") or ""
        chapter_url = u.get("chapter_url") or ""
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
        _ceil = latest_sent.get((str(series_title or ""), "voratoon"), latest_sent.get((normalize_title_key(series_title or ""), "voratoon"), 0))
        if _chn is not None and _ceil and _chn <= _ceil:
            continue
        items.append({"title": series_title, "title_key": normalize_title_key(series_slug), "chapter": ch_str, "chapter_num": _parse_chapter_num(ch_str), "url": chapter_url, "source": "voratoon", "cover": series_cover, "series_url": series_url, "chapter_url": chapter_url, "origin": origin, "updated_time": _ut, "description": u.get("description") or "", "genres": u.get("genres") or [], "rating": normalize_rating(u.get("rating")), "type": u.get("type") or ""})
    return items
