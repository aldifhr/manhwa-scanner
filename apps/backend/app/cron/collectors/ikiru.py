"""Ikiru per-series collector.

Fetches page 1 of the project manga list (24 series), then for each series
extracts the embedded chapter list. Only 1 page is needed — the API returns
24 series per page and the total catalogue is ~146 series.

The API response already includes chapters per series, so no separate chapter
fetch is needed.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.config import settings
from app.logger import get_logger
from app.services.fcfs import parse_chapter_number as _parse_chapter_num
from app.services.rating_utils import normalize_rating
from app.services.scanner_confidence import attach_confidence
from app.utils.text import slugify_title_key

logger = get_logger("cron:collect:ikiru")

SOURCE = "ikiru"
MAX_PAGES = 1
MAX_CHAPTERS_PER_SERIES = 25


def _parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _collect_ikiru_source(latest_sent: dict, disabled: set, fetch_meta: bool = True) -> list[dict]:
    from app.scrapers import ikiru as ik

    try:
        lookback = int(getattr(settings, "RSS_LOOKBACK_HOURS", 24))
    except Exception:
        lookback = 24
    cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback)

    items: list[dict] = []

    for page in range(1, MAX_PAGES + 1):
        data = ik.get_ikiru_project_page(page=page)
        if not data:
            break

        projects = data.get("data", {}).get("project", [])
        if not projects:
            break

        for series in projects:
            if not isinstance(series, dict):
                continue

            title = (series.get("title") or "").strip()
            if not title:
                continue

            slug = series.get("slug") or ""
            if not slug:
                continue

            tk = slugify_title_key(title)
            series_url = ik.series_url_for(slug)

            # Derive type/origin from the type field
            raw_type = str(series.get("type") or "").strip()
            content_type, origin = ik._derive_format(raw_type)

            cover = series.get("featuredImage") or ""
            rating = 0.0
            meta = series.get("metadata") or {}
            if meta.get("score") not in (None, ""):
                rating = normalize_rating(meta.get("score")) or 0.0

            genres = [g.get("name", "") for g in (meta.get("genre") or []) if isinstance(g, dict) and g.get("name")]

            description = str(series.get("description") or "").strip()

            chapters = series.get("chapter") or []
            if not isinstance(chapters, list):
                chapters = []

            ceiling = latest_sent.get((tk, SOURCE), 0)
            kept = 0

            for ch in chapters:
                if kept >= MAX_CHAPTERS_PER_SERIES:
                    break
                if not isinstance(ch, dict):
                    continue

                ch_num_raw = ch.get("number")
                if ch_num_raw is None:
                    continue

                ch_str = str(ch_num_raw)
                dt = _parse_ts(ch.get("updatedAt"))
                if dt is None or dt < cutoff:
                    continue

                num = _parse_chapter_num(ch_str)
                if num is not None and ceiling and num <= ceiling:
                    continue

                chapter_url = ik.chapter_url_for(slug, ch_num_raw)
                kept += 1

                items.append({
                    "title": title,
                    "title_key": tk,
                    "chapter": ch_str,
                    "chapter_num": num,
                    "url": chapter_url,
                    "source": SOURCE,
                    "cover": cover,
                    "series_url": series_url,
                    "chapter_url": chapter_url,
                    "origin": origin,
                    "updated_time": dt.isoformat(),
                    "release_date": dt.isoformat(),
                    "rating": rating,
                    "genres": genres,
                    "description": description,
                    "type": content_type,
                })

        logger.info(
            "ikiru collect done",
            items=len(items),
            page=page,
            series=len(projects),
        )

    return attach_confidence(items, SOURCE)
