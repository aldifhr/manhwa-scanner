"""Kiryuu (v7.kiryuu.to) per-series collector."""

from datetime import datetime, timezone, timedelta

from app.config import settings
from app.logger import get_logger
from app.services.rating_utils import normalize_rating
from app.utils.text import slugify_title_key
from app.services.fcfs import parse_chapter_number as _parse_chapter_num
from app.scrapers import kiryuu as _kiryuu_scraper
from app.services.scanner_confidence import attach_confidence

logger = get_logger("cron:collect:kiryuu")


def _collect_kiryuu_source(latest_sent: dict, disabled: set) -> list[dict]:
    try:
        _lookback = int(getattr(settings, "RSS_LOOKBACK_HOURS", 24))
    except Exception:
        _lookback = 24
    _cutoff = datetime.now(timezone.utc) - timedelta(hours=_lookback)

    items: list[dict] = []

    updates = _kiryuu_scraper.fetch_latest_updates(page=1, per_page=32)
    if not updates:
        return items

    seen_chapters: dict[tuple[str, int], dict] = {}
    series_order: list[str] = []
    series_info: dict[str, dict] = {}

    for entry in updates:
        comic = entry.get("comic", {})
        chapters = entry.get("chapters", [])
        if not comic or not chapters:
            continue

        title = comic.get("title", "")
        slug = comic.get("slug", "")
        if not title or not slug:
            continue

        if slug not in series_info:
            series_info[slug] = {
                "title": title,
                "cover": comic.get("cover", ""),
                "rating": comic.get("rating"),
                "genres": comic.get("genres", []) or [],
                "type": (comic.get("type") or "manhwa").lower(),
            }
            series_order.append(slug)

        for ch in chapters:
            ch_num = ch.get("n")
            ch_id = ch.get("id")
            if ch_num is None or not ch_id:
                continue
            key = (slug, ch_num)
            if key not in seen_chapters:
                seen_chapters[key] = {
                    "ch_id": ch_id,
                    "released_at": ch.get("releasedAt"),
                }

    for slug in series_order:
        info = series_info[slug]
        tk = slugify_title_key(slug)
        cover = info["cover"]
        rating = normalize_rating(info["rating"]) if info["rating"] else 0.0
        genres = info["genres"]
        _type = info["type"]

        series_chapters = [
            (slug, ch_num, ch_data)
            for (s, ch_num), ch_data in seen_chapters.items()
            if s == slug
        ]
        series_chapters.sort(key=lambda x: x[1], reverse=True)

        for _, ch_num, ch_data in series_chapters:
            ch_str = str(ch_num)
            chapter_url = _kiryuu_scraper.chapter_url(slug, ch_num, ch_data.get("ch_id"))
            _chn = _parse_chapter_num(ch_str)

            _ceil = latest_sent.get((tk, "kiryuu"), 0)
            if _chn is not None and _ceil and _chn <= _ceil:
                continue

            released_at = ch_data.get("released_at")
            if released_at:
                try:
                    ch_dt = datetime.fromtimestamp(released_at / 1000, tz=timezone.utc)
                    if ch_dt < _cutoff:
                        continue
                except (ValueError, TypeError, OSError):
                    pass

            _released_iso = ""
            if released_at:
                try:
                    _released_iso = datetime.fromtimestamp(released_at / 1000, tz=timezone.utc).isoformat()
                except (ValueError, TypeError, OSError):
                    pass

            _origin = ""
            if _type == "manhwa":
                _origin = "KR"
            elif _type == "manhua":
                _origin = "CN"
            elif _type == "manga":
                _origin = "JP"

            items.append({
                "title": info["title"],
                "title_key": tk,
                "chapter": ch_str,
                "chapter_num": _chn,
                "url": chapter_url,
                "source": "kiryuu",
                "cover": cover,
                "series_url": _kiryuu_scraper.series_url(slug),
                "chapter_url": chapter_url,
                "origin": _origin,
                "updated_time": _released_iso,
                "release_date": _released_iso,
                "rating": rating,
                "genres": genres,
                "description": "",
                "type": _type,
            })

    return attach_confidence(items, "kiryuu")
