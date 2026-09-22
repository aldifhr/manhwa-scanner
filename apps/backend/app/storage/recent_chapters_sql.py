"""Recent chapters storage — pure SQL helpers (prune, batch insert, fetch).

Moved from recent_chapters.py to separate orchestration (claim) from storage I/O.
Module-level state (whitelist origin cache, existing-rc cache) lives here so all
helpers share it without crossing module boundaries.
"""
from datetime import datetime, timezone, timedelta
import hashlib
import threading

from app.db import get_supabase
from app.logger import get_logger
from app.utils.text import normalize_shinigami_url
from app.utils.origin import normalize_origin

logger = get_logger("storage:recent-chapters-sql")

from app.storage.recent_chapters_window import prune_older_than, prune_dispatch_history_older_than
from app.storage.recent_chapters_caches import (
    _load_existing_rc,
    _get_wl_origins,
    invalidate_whitelist_origin_cache,
    _norm_chapter_num,
)

from app.storage.recent_chapters_ingest import batch_insert_recent_chapters

def _composite_key(r: dict) -> tuple[str, str, str] | None:
    from app.storage.recent_chapters_caches import _norm_chapter_num as _ncn
    tk = r.get("title_key") or ""
    src = r.get("source") or ""
    cn = _ncn(r.get("chapter_num"))
    if not tk or not src:
        return None
    if cn is None:
        return (tk, src, "oneshot")
    return (tk, src, cn)

def get_trending(hours: int = 24, limit: int = 25) -> list[dict]:
    """Trending series = those releasing the MOST chapters within `hours`.

    Aggregates recent_chapters (flat, per-source) by (title_key, source),
    counts chapters in the window (release velocity = 'naik daun'),
    joins rating from whitelist. Returns newest-first by
    chapter_count then last activity.
    """
    try:
        from app.db import q
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        sql = """
            SELECT
                rc.title_key,
                rc.source,
                MAX(rc.title) AS title,
                MAX(rc.origin) AS origin,
                MAX(rc.cover) AS cover,
                MAX(rc.series_url) AS series_url,
                COUNT(*) AS chapter_count,
                MAX(rc.updated_time) AS last_update,
                MAX(w.rating) AS rating
            FROM recent_chapters rc
            LEFT JOIN whitelist w
                ON w.title_key = rc.title_key AND w.source = rc.source
            WHERE rc.updated_time >= %s
            GROUP BY rc.title_key, rc.source
            ORDER BY chapter_count DESC, last_update DESC
            LIMIT %s
        """
        rows = q(sql, [cutoff, limit]) or []
        out = []
        for r in rows:
            if not (r.get("series_url") or "").strip():
                continue
            try:
                rating = float(r.get("rating") or 0) or 0.0
            except (ValueError, TypeError):
                rating = 0.0
            out.append({
                "title_key": r.get("title_key", ""),
                "source": r.get("source", ""),
                "title": r.get("title", ""),
                "cover": r.get("cover") or "",
                "series_url": r.get("series_url") or "",
                "chapter_count": int(r.get("chapter_count") or 0),
                "last_update": r.get("last_update") or "",
                "rating": rating,
                "score": round(int(r.get("chapter_count") or 0) + rating / 2.0, 2),
            })
        return out
    except Exception as e:
        logger.error("get_trending failed", exc=e)
        return []

def get_recent_chapters(hours: int = 24) -> list[dict]:
    """Load ALL chapters found within the last `hours` (used by dispatch /
    dashboard callers that need the full set). For web pagination use
    get_recent_chapters_paginated() instead."""
    rows = _fetch_recent_rows(hours=hours, limit=1500, offset=0)
    return [_row_to_item(r) for r in rows]

def get_recent_chapters_paginated(
    page: int = 1, limit: int = 24, hours: int = 24, source: str | None = None
) -> tuple[list[dict], int, int]:
    """Server-side paginated recent chapters for the web RSS feed.

    Only fetches the single page requested (page*limit rows) so infinite
    scroll stays cheap — no loading of all 1500 rows + enriching them just
    to return 24. `source` (if given) is filtered DB-side so pagination
    stays correct per-source. Returns (items, total, total_pages).
    """
    total = _count_recent_rows(hours=hours, source=source)
    total_pages = (total + limit - 1) // limit if limit else 1
    offset = max(0, (page - 1) * limit)
    rows = _fetch_recent_rows(hours=hours, limit=limit, offset=offset, source=source)
    return [_row_to_item(r) for r in rows], total, total_pages

def _count_recent_rows(hours: int = 24, source: str | None = None) -> int:
    try:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        q = (
            get_supabase()
            .table("recent_chapters")
            .select("*", count="exact")
            .gte("updated_time", cutoff)
        )
        if source:
            q = q.eq("source", source)
        res = q.execute()
        return res.count or 0
    except Exception as e:
        logger.error("count recent_chapters failed", exc=e)
        return 0

def _fetch_recent_rows(
    hours: int = 24, limit: int = 1500, offset: int = 0, source: str | None = None
) -> list[dict]:
    try:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        q = (
            get_supabase()
            .table("recent_chapters")
            .select("*")
            .gte("updated_time", cutoff)
            # Sort by PK (id) descending — insertion order ≈ chronological,
            # and critically STABLE across pages. Ordering by updated_time
            # alone is unstable (many rows share the same timestamp) which
            # made offset pagination return overlapping rows on page 1/2.
            .order("id", desc=True)
            .limit(limit)
            .offset(offset)
        )
        if source:
            q = q.eq("source", source)
        res = q.execute()
        return res.data or []  # type: ignore
    except Exception as e:
        logger.error("fetch recent_chapters failed", exc=e)
        return []

def _row_to_item(r: dict) -> dict:
    item = {
        "id": r.get("id"),
        "title": r.get("title", ""),
        "title_key": r.get("title_key", ""),
        "chapter": str(r.get("chapter") or ""),
        "chapter_num": r.get("chapter_num") or 0,
        "url": r.get("chapter_url") or r.get("url", ""),
        "chapter_url": r.get("chapter_url") or r.get("url", ""),
        "source": r.get("source", ""),
        # Return a short same-origin cover ref (BE-3c) instead of the raw
        # (often very long MinIO) URL. The DB keeps the raw URL; this only
        # rewrites on read so the backend proxy resolves it server-side.
        "cover": r.get("cover") or "",
        "series_url": r.get("series_url") or "",
        "updated_time": r.get("updated_time") or "",
        "description": r.get("description") or "",
        # Carry rating + genres through to dispatch embeds. Previously dropped
        # here, so voratoon (and all sources via the claim path) rendered empty
        # rating/genre in Discord. DB stores them; the embed builder consumes them.
        "rating": r.get("rating") or "",
        "genres": r.get("genres") or [],
        "origin": r.get("origin") or "",
        "type": r.get("type") or "",  # <-- ADDED for origin derivation fallback
    }
    su = item.get("series_url")
    if su:
        item["series_url"] = normalize_shinigami_url(su) or su
    for fld in ("url", "chapter_url", "cover"):
        v = item.get(fld)
        if isinstance(v, str) and "shinigami.asia" in v:
            item[fld] = normalize_shinigami_url(v) or v
    return item
