"""Unified metadata enrichment for whitelist entries.

Fetches rich metadata (cover, rating, genres, description, status)
from source APIs (ikiru / shinigami) and stores directly in the
whitelist table — single source of truth, no manga_metadata dependency.
"""

from app.db import get_supabase
from app.logger import get_logger

logger = get_logger("enrich")


def _is_voratoon_expiring_soon(cover: str, hours: int = 24) -> bool:
    """Check if presigned voratoon cover expires within hours."""
    if not cover or "cvr.voratoon.id" not in cover:
        return False
    import re as _re
    from datetime import datetime as _dt, timezone as _tz
    import time as _time
    m = _re.search(r"X-Amz-Date=([^&]+).*?X-Amz-Expires=(\d+)", cover)
    if not m:
        return False
    try:
        d = m.group(1)
        exp = int(m.group(2))
        dt = _dt.strptime(d, "%Y%m%dT%H%M%SZ").replace(tzinfo=_tz.utc)
        expiry = dt.timestamp() + exp
        return _time.time() > expiry - hours * 3600
    except Exception:
        return False


def enrich_whitelist_entry(title_key: str, source: str, series_url: str | None = None) -> dict | None:
    """Fetch metadata from source API. Returns dict of updates or None."""
    updates: dict = {}

    if source == "voratoon":
        # voratoon slug == title_key lowercased
        slug = title_key.lower() if title_key else ""
        if series_url and "/series/" in series_url:
            slug = series_url.rstrip("/").split("/")[-1].lower()
        if not slug:
            return None
        from app.scrapers import voratoon as _vt
        from app.utils.cover_scrub import scrub_cover as _scrub
        # 1) coba direct /series/{slug}, 2) fallback filter slug==slug
        data = None
        try:
            data = _vt.fetch_series_detail(slug)
        except Exception:
            data = None
        # fetch_series_detail returns {"id":..., "data": {...}} atau None
        # kalau None, coba filter list
        if not data:
            try:
                import httpx as _hx
                from app.config import settings as _st
                base = _st.VORATOON_API_URL.rstrip("/")
                url = f"{base}/series"
                params = {"take": 1, "page": 1, "includeMeta": "true", "takeChapter": 1, "filter": f"slug=={slug}"}
                r = _hx.get(url, params=params, timeout=30.0)
                r.raise_for_status()
                j = r.json()
                arr = j.get("data") or []
                if arr:
                    data = arr[0]
            except Exception:
                pass
        if not data:
            return None
        inner = data.get("data", data) if isinstance(data, dict) else {}
        cover = _scrub(inner.get("coverImage") or "")
        if cover:
            updates["cover"] = cover
        rating = inner.get("rating")
        if rating not in (None, "", 0):
            try:
                updates["rating"] = float(rating)
            except Exception:
                pass
        genres = inner.get("genres") or []
        # genres bisa [{data:{name}}] atau [str]
        gnames = []
        for g in genres:
            if isinstance(g, dict):
                n = g.get("data", {}).get("name") if isinstance(g.get("data"), dict) else g.get("name")
                if n:
                    gnames.append(n)
            elif isinstance(g, str) and g:
                gnames.append(g)
        if gnames:
            updates["genres"] = gnames
        syn = inner.get("synopsis") or ""
        if syn:
            updates["description"] = syn[:2000]
        fmt = (inner.get("format") or "").lower()
        if fmt:
            updates["type"] = fmt
            updates["origin"] = "CN" if fmt == "manhua" else "KR"
        if updates:
            updates["source"] = "voratoon"
        return updates if updates else None

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
    voratoon_cutoff = (now - timedelta(days=5)).isoformat()

    updated = 0
    skipped = 0
    refreshed = 0
    for r in rows:
        tk = r["title_key"]
        src = r.get("source", "")
        su = r.get("series_url")

        # voratoon presigned cover expiry — force refresh kalau sisa <24h
        is_expiring = False
        if src == "voratoon":
            is_expiring = _is_voratoon_expiring_soon(r.get("cover") or "", hours=24)

        # voratoon pakai window 5 hari (cover 6 hari), lainnya pakai refresh_days (7)
        effective_cutoff = voratoon_cutoff if src == "voratoon" else refresh_cutoff

        all_present = (
            r.get("genres") and r.get("description") and r.get("rating")
            and r.get("status") and r.get("cover") and r.get("origin")
        )
        enriched_at = r.get("metadata_enriched_at")
        _ea_str = str(enriched_at) if enriched_at is not None else None

        # kalau voratoon expiring soon, jangan skip — paksa refresh
        if is_expiring:
            refreshed += 1
        elif all_present:
            # Complete — only refresh if older than the refresh window.
            if _ea_str and _ea_str >= effective_cutoff:
                skipped += 1
                continue
            refreshed += 1
        else:
            # Incomplete — but if we enriched very recently, don't hammer the
            # upstream API again (it may have returned partial data).
            if _ea_str and _ea_str >= effective_cutoff:
                skipped += 1
                continue

        try:
            updates = enrich_whitelist_entry(tk, src, su)
            if updates:
                updates["metadata_enriched_at"] = now.isoformat()
                sb.table("whitelist").update(updates).eq("title_key", tk).eq("source", src).execute()
                # voratoon: sync fresh cover ke recent_chapters juga biar RSS/feed gak expired
                if src == "voratoon" and updates.get("cover"):
                    try:
                        sb.table("recent_chapters").update({"cover": updates["cover"]}).eq("title_key", tk).eq("source", "voratoon").execute()
                    except Exception:
                        pass
                updated += 1
        except Exception as e:
            logger.warn("enrich failed", title_key=tk, err=str(e)[:120])

    # --- refresh voratoon covers di excluded_titles & chapter_bookmarks (expire 6 hari, sama) ---
    try:
        # excluded_titles: whitelist-excluded tapi cover tetap presigned
        ex_rows = sb.table("excluded_titles").select("title_key, cover, source").eq("source", "voratoon").limit(100).execute().data or []
        for er in ex_rows:
            if not _is_voratoon_expiring_soon(er.get("cover") or "", hours=24):
                continue
            slug = er.get("title_key") or ""
            if not slug:
                continue
            upd = enrich_whitelist_entry(slug, "voratoon", None)
            if upd and upd.get("cover"):
                try:
                    sb.table("excluded_titles").update({"cover": upd["cover"]}).eq("title_key", slug).eq("source", "voratoon").execute()
                    updated += 1
                except Exception:
                    pass
        # chapter_bookmarks: per-chapter bookmark cover juga presigned
        try:
            from app.db import q as _q2
            bm_rows = _q2("SELECT DISTINCT title_key, cover FROM chapter_bookmarks WHERE source='voratoon' AND cover LIKE '%%cvr.voratoon.id%%' LIMIT 100", [])
            for br in bm_rows or []:
                if not _is_voratoon_expiring_soon(br.get("cover") or "", hours=24):
                    continue
                slug = br.get("title_key") or ""
                if not slug:
                    continue
                upd = enrich_whitelist_entry(slug, "voratoon", None)
                if upd and upd.get("cover"):
                    try:
                        _q2("UPDATE chapter_bookmarks SET cover=%s, updated_at=%s WHERE title_key=%s AND source='voratoon' AND cover LIKE '%%cvr.voratoon.id%%'", [upd["cover"], now.isoformat(), slug])
                        updated += 1
                    except Exception:
                        pass
        except Exception:
            pass
    except Exception as e:
        logger.warn("voratoon extra refresh failed", err=str(e)[:120])

    logger.info("enrich_all_whitelist done", updated=updated, refreshed=refreshed, skipped=skipped, total=len(rows))
    return updated
