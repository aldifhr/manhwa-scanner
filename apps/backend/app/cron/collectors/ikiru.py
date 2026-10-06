"""Ikiru collector.

Walks the catalogue by type and turns each series' latest chapter into a
pipeline item. One list request per page carries the full metadata AND the
series' newest chapter with a real `updatedAt`, so unlike voratoon there is no
per-series follow-up request on the hot path.

Whitelist gates dispatch downstream, not collection — the same contract the
other sources follow. The catalogue is small enough (219 manhwa + 78 manhua +
246 manga ≈ 543 series, ~26 pages at limit=50) that walking it every cycle is
cheaper than per-series detail calls.
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
PAGE_LIMIT = 50


def _parse_ts(value) -> datetime | None:
    """Delegate to the scraper's parser — ikiru mislabels WIB as UTC."""
    from app.scrapers.ikiru import parse_ikiru_ts

    return parse_ikiru_ts(value)


def _items_from_row(row: dict, cutoff: datetime, latest_sent: dict, fetch_meta: bool) -> list[dict]:
    """One series row -> at most one item (its newest chapter inside the window).

    The catalogue row exposes `chapter` as a small array of the newest chapters;
    we take the highest-numbered one that is still inside the lookback window.
    Chapters below the dispatch ceiling are dropped here so the pipeline never
    even sees a re-touched old chapter.
    """
    slug = str(row.get("slug") or "").strip()
    title = str(row.get("title") or "").strip()
    if not slug or not title:
        return []

    tk = slugify_title_key(title)
    if not tk:
        return []

    manga_type = str(row.get("type") or "").upper()
    from app.scrapers.ikiru import TYPE_TO_ORIGIN, _chapter_url, _series_url

    content_type, origin = TYPE_TO_ORIGIN.get(manga_type, ("", "KR"))

    meta = row.get("metadata") or {}
    genres = [
        str(g.get("name"))
        for g in (meta.get("genre") or [])
        if isinstance(g, dict) and g.get("name")
    ]
    rating = normalize_rating(meta.get("score")) or 0.0
    description = str(row.get("description") or "").strip()

    ceiling = latest_sent.get((tk, SOURCE), 0)

    best = None
    for ch in row.get("chapter") or []:
        if not isinstance(ch, dict):
            continue
        num = _parse_chapter_num(ch.get("number"))
        if num is None:
            continue
        ts = _parse_ts(ch.get("updatedAt"))
        if ts is None or ts < cutoff:
            continue
        if ceiling and num <= ceiling:
            continue
        if best is None or num > best[0]:
            best = (num, ts, ch)

    if best is None:
        return []

    num, ts, ch = best
    return [
        {
            "title": title,
            "title_key": tk,
            "chapter": str(ch.get("number")),
            "chapter_num": num,
            "url": _chapter_url(slug, ch.get("number")),
            "chapter_url": _chapter_url(slug, ch.get("number")),
            "source": SOURCE,
            "cover": str(row.get("featuredImage") or ""),
            "series_url": _series_url(slug),
            "origin": origin,
            "updated_time": ts.isoformat(),
            "release_date": ts.isoformat(),
            "rating": rating,
            "genres": genres,
            "description": description,
            "type": content_type,
        }
    ]


def _collect_ikiru_source(latest_sent: dict, disabled: set, fetch_meta: bool = True) -> list[dict]:
    from app.scrapers import ikiru as ik

    if SOURCE in (disabled or set()):
        return []

    try:
        lookback = int(getattr(settings, "RSS_LOOKBACK_HOURS", 24))
    except Exception:
        lookback = 24
    cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback)

    items: list[dict] = []
    for manga_type, row in ik.iter_all_series():
        try:
            items.extend(_items_from_row(row, cutoff, latest_sent, fetch_meta))
        except Exception as exc:  # noqa: BLE001
            logger.warn("ikiru row failed", slug=str(row.get("slug"))[:60], err=str(exc)[:120])

    logger.info("ikiru collect done", items=len(items))
    return attach_confidence(items, SOURCE)
