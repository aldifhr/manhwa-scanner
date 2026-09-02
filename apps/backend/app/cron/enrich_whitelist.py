"""Unified metadata enrichment for whitelist entries.

Fetches rich metadata (cover, rating, genres, description, status)
from source APIs (ikiru / shinigami) and stores directly in the
whitelist table — single source of truth, no manga_metadata dependency.
"""

from app.db import get_supabase
from app.logger import get_logger

logger = get_logger("enrich")


def enrich_whitelist_entry(title_key: str, source: str, series_url: str | None = None) -> dict | None:
    """Fetch metadata from source API. Returns dict of updates or None."""
    updates: dict = {}

    if source == "ikiru":
        from app.scrapers import ikiru
        # Derive slug from series_url or title_key
        slug = None
        if series_url and "/manga/" in series_url:
            slug = series_url.split("/manga/")[-1].strip("/").split("/")[0]
        if not slug:
            from app.utils.text import ikiru_slug
            slug = ikiru_slug(title_key)

        meta = ikiru.get_ikiru_series_meta(slug)
        if meta:
            for f in ("cover", "rating", "genres", "description", "type"):
                v = meta.get(f)
                if v:
                    updates[f] = v
            updates["source"] = "ikiru"

    elif source == "shinigami":
        from app.scrapers import shinigami
        # Derive manga_id from series_url, else from recent_chapters
        mid = None
        if series_url and "shinigami.asia/series/" in series_url:
            mid = series_url.rstrip("/").split("/")[-1]
        if not mid:
            # fallback: look up series_url from recent_chapters by title_key
            try:
                from app.db import get_supabase as _gsb
                _rc = _gsb().table("recent_chapters").select("series_url").eq(
                    "title_key", title_key
                ).eq("source", "shinigami").neq("series_url", "").limit(1).execute()
                if _rc.data:
                    _row = _rc.data[0]
                    _su = str((_row.get("series_url") if isinstance(_row, dict) else "") or "")
                    if "shinigami.asia/series/" in _su:
                        mid = _su.rstrip("/").split("/")[-1]
            except Exception:
                pass
        if not mid:
            # last resort: search API by title to resolve the manga UUID
            try:
                from app.scrapers import shinigami as _sh
                _q = title_key.replace("-", " ").strip()
                _hits = _sh.search_shinigami_api(_q, per_page=5)
                for _h in (_hits or []):
                    _hid = _h.get("id") or _h.get("manga_id") or _h.get("uuid")
                    if _hid:
                        mid = str(_hid)
                        break
            except Exception:
                pass
        if not mid:
            return None

        meta = shinigami.get_shinigami_series_meta(mid)
        if meta:
            for f in ("cover", "rating", "genres", "description", "status", "type"):
                v = meta.get(f)
                if v:
                    updates[f] = v
            updates["source"] = "shinigami"

    return updates if updates else None


def enrich_all_whitelist(max_age_hours: int = 24, refresh_days: int = 7) -> int:
    """Enrich whitelist entries with upstream metadata (cover, rating, genres,
    description, status, type, origin).

    PERF-01 fix: previously the SELECT omitted rating/status/cover/origin, so the
    "all_present" completeness check could never be True (those fields read as
    None) and EVERY entry was re-enriched on every cron tick — 343 × N upstream
    requests/hour. Now:
      - we SELECT all completeness fields,
      - skip entries that are already complete AND were enriched within
        `refresh_days` (default 7d) — metadata like genre/rating/status rarely
        changes, so re-fetching every few minutes is pure waste,
      - new titles (metadata_enriched_at IS NULL) are enriched immediately,
      - older-than-refresh entries get a refresh.

    Returns count updated.
    """
    sb = get_supabase()

    # Pull ALL fields used by the completeness check + the throttle timestamp.
    rows = sb.table("whitelist").select(
        "title_key, source, series_url, genres, description, rating, status, cover, origin, type, metadata_enriched_at"
    ).execute().data or []

    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    refresh_cutoff = (now - timedelta(days=refresh_days)).isoformat()

    updated = 0
    skipped = 0
    refreshed = 0
    for r in rows:
        tk = r["title_key"]
        src = r.get("source", "")
        su = r.get("series_url")

        all_present = (
            r.get("genres") and r.get("description") and r.get("rating")
            and r.get("status") and r.get("cover") and r.get("origin")
        )
        enriched_at = r.get("metadata_enriched_at")
        _ea_str = str(enriched_at) if enriched_at is not None else None

        if all_present:
            # Complete — only refresh if older than the refresh window.
            if _ea_str and _ea_str >= refresh_cutoff:
                skipped += 1
                continue
            refreshed += 1
        else:
            # Incomplete — but if we enriched very recently, don't hammer the
            # upstream API again (it may have returned partial data).
            if _ea_str and _ea_str >= refresh_cutoff:
                skipped += 1
                continue

        try:
            updates = enrich_whitelist_entry(tk, src, su)
            if updates:
                updates["metadata_enriched_at"] = now.isoformat()
                sb.table("whitelist").update(updates).eq("title_key", tk).eq("source", src).execute()
                updated += 1
        except Exception as e:
            logger.warn("enrich failed", title_key=tk, err=str(e)[:120])

    logger.info("enrich_all_whitelist done", updated=updated, refreshed=refreshed, skipped=skipped, total=len(rows))
    return updated
