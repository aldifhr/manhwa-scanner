"""Chapter enrichment + backfill (metadata attach, 24h split).

This module has been consolidated: heavy enrichment logic now lives in
app/services/scraper_service.py. The public symbols here remain exported
(via pipeline.py) for backward compatibility.
"""
from __future__ import annotations

import html as _html
import re

from app.cron.collect import _parse_types
from app.logger import get_logger
from app.scrapers import ikiru, shinigami
from app.scrapers.shinigami import _country_to_type
from app.storage import metadata as meta_store
from app.utils.origin import normalize_origin

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

def _strip_html(s: str) -> str:
    """Remove HTML tags and collapse whitespace from a description."""
    if not s:
        return ""
    s = _TAG_RE.sub(" ", str(s))
    s = _html.unescape(s)
    s = _WS_RE.sub(" ", s).strip()
    return s

logger = get_logger("cron:enrich")


def enrich(items: list[dict], persist_cache: bool = False, skip_api: bool = False) -> list[dict]:
    """Attach metadata (cover/status/rating). Check whitelist cache first, fallback to API.

    skip_api=True → never hit the source APIs; use only the whitelist cache.
    This is used by the live /api/rss endpoint so a page load doesn't trigger
    100+ sequential API calls (which took ~11s). The cron rss-fetch pass already
    populated whitelist, so the cache is fresh enough for web display.
    """

    def _ikiru_slug(it: dict) -> str | None:
        return it["series_url"].rstrip("/").split("/")[-1] if it.get("series_url") else None

    def _shinigami_id(it: dict) -> str | None:
        return it["series_url"].rstrip("/").split("/")[-1] if it.get("series_url") else None

    # ── Collect keys per source ──
    ikiru_slugs: list[str] = []
    shin_mids: list[str] = []
    ikiru_idx: dict[str, list[int]] = {}
    shin_idx: dict[str, list[int]] = {}
    for i, it in enumerate(items):
        if it.get("source") == "ikiru":
            slug = _ikiru_slug(it)
            if slug:
                ikiru_slugs.append(slug)
                ikiru_idx.setdefault(slug, []).append(i)
        elif it.get("source") == "shinigami":
            mid = _shinigami_id(it)
            if mid:
                shin_mids.append(mid)
                shin_idx.setdefault(mid, []).append(i)

    # ── Cache load (by title_key) ──
    cache_keys = list(set(ikiru_slugs + shin_mids))
    cached: dict[str, dict] = {}
    if cache_keys:
        rows = meta_store.batch_get_manga_metadata(cache_keys)
        for key, row in zip(cache_keys, rows):
            if row:
                if row.get("origin") and row["origin"] not in ("KR", "CN", "JP"):
                    row["origin"] = normalize_origin(row.get("origin"))
                cached[key] = row

    # ── Ikiru enrich (parallelized) ──
    import concurrent.futures

    def _fetch_ikiru(slug: str) -> tuple[str, dict | None]:
        if cached.get(slug, {}).get("origin"):
            return slug, None  # already enriched in cache
        if skip_api:
            return slug, None
        try:
            s = ikiru.get_ikiru_series(slug)
        except Exception:
            s = None
        return slug, s

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        futures = {ex.submit(_fetch_ikiru, slug): slug for slug in set(ikiru_slugs)}
        for fut in concurrent.futures.as_completed(futures):
            slug, s = fut.result()
            if not s:
                continue
            cached[slug] = s
            # Do NOT auto-upsert to whitelist on RSS fetch — that's enrich_whitelist's job
            # if persist_cache:
            #     ... (removed)

    # ── Ikiru apply to items ──
    for slug, indices in ikiru_idx.items():
        s = cached.get(slug)
        if not s:
            continue
        is_project = s.get("is_project")
        _types = _parse_types(s.get("type"))
        ikiru_origin = normalize_origin(_types[0]) if _types else ""
        if not ikiru_origin:
            ikiru_origin = (cached.get(slug, {}) or {}).get("origin") or ""
        for i in indices:
            it = items[i]
            it["cover"] = s.get("cover")
            it["status"] = ("ongoing" if is_project else "completed") if is_project is not None else (s.get("status") or "unknown")
            it["rating"] = s.get("rating")
            it["genres"] = s.get("genres") or s.get("genre") or []
            it["description"] = _strip_html(s.get("description", ""))
            # no type -> no origin (hide flag) — don't fallback to KR
            # Only override origin if we have a new value; preserve existing DB origin
            if _types and ikiru_origin:
                it["origin"] = normalize_origin(ikiru_origin)
            elif not it.get("origin"):
                it["origin"] = ""

    # ── Shinigami enrich (parallelized) ──
    def _fetch_shin(mid: str) -> tuple[str, dict | None]:
        # Fetch-mode shinigami rows already carry rating/cover/origin from the
        # latest-updates list (see _collect_shinigami_source). Don't burn the
        # strict per-IP rate limit re-fetching series we already have data for —
        # only hit the API when the row is missing rating AND cover.
        _idx = shin_idx.get(mid, [])
        _it = items[_idx[0]] if _idx else {}
        if _it.get("rating") not in (None, 0) and _it.get("cover"):
            return mid, None
        if mid in cached and cached[mid].get("origin"):
            return mid, None
        if skip_api:
            return mid, None
        try:
            s = shinigami.get_shinigami_series(mid)
        except Exception:
            s = None
        if not s:
            return mid, None
        status_map = {"1": "ongoing", "2": "completed", "3": "hiatus"}
        tax = s.get("taxonomy") or []
        if isinstance(tax, dict):
            genres = [g.get("name") for g in tax.get("Genre", []) if g.get("name")]
        elif isinstance(tax, list):
            genres = [t for t in tax if isinstance(t, str)]
        else:
            genres = []
        _shin_new = normalize_origin(s.get("country_id"))
        _shin_old = (cached.get(mid, {}) or {}).get("origin") or ""
        _shin_origin = _shin_new if _shin_new in ("KR", "CN", "JP") else _shin_old
        mapped = {
            "title_key": mid,
            "source": "shinigami",
            "cover": s.get("cover_image_url") or s.get("cover_portrait_url") or "",
            "status": status_map.get(str(s.get("status")), "unknown"),
            "rating": float(s.get("user_rate")) if s.get("user_rate") not in (None, "", 0) else 0.0,
            "genres": genres,
            "description": s.get("description") or s.get("synopsis") or "",
            "origin": _shin_origin,
            "type": _country_to_type(s.get("country_id")) or s.get("type") or "",
        }
        return mid, mapped

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_fetch_shin, mid): mid for mid in set(shin_mids)}
        for fut in concurrent.futures.as_completed(futures):
            mid, mapped = fut.result()
            if not mapped:
                continue
            cached[mid] = mapped
            # Do NOT auto-upsert to whitelist on RSS fetch — that's enrich_whitelist's job
            # if persist_cache:
            #     meta_store.upsert_manga_metadata([mapped])

    # ── Shinigami apply to items ──
    for mid, indices in shin_idx.items():
        s = cached.get(mid)
        if not s:
            continue
        shin_origin = normalize_origin(s.get("origin"))
        for i in indices:
            it = items[i]
            # Preserve list-provided values; only fill gaps from series_meta.
            it["cover"] = it.get("cover") or s.get("cover") or ""
            it["status"] = s.get("status", "unknown") or it.get("status", "")
            if not it.get("rating"):
                it["rating"] = s.get("rating", "")
            if not it.get("genres"):
                it["genres"] = s.get("genres", [])
            it["description"] = _strip_html(s.get("description", "")) or it.get("description", "")
            it["origin"] = normalize_origin(shin_origin or it.get("origin", ""))
            # Update type from cached shinigami data if available
            if not it.get("type") and s.get("type"):
                it["type"] = s["type"]

    # Final safety: ensure every item's origin is a canonical country code
    for it in items:
        if it.get("origin"):
            it["origin"] = normalize_origin(it["origin"])

    return items


def _split_send_backfill(items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Strict-24h split: items with a real (non-backfill) updated_time within
    24h go to Discord; HTML-backlog items (flagged html_backlog, no real
    timestamp) go to silent backfill.
    """
    from datetime import datetime, timezone, timedelta
    from app.cron.dispatch_mod import fcfs_key

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    to_send: list[dict] = []
    to_backfill: list[dict] = []
    seen_fcfs: set[str] = set()
    for it in items:
        norm = fcfs_key(it.get("title", ""), it.get("chapter", ""))
        if norm in seen_fcfs:
            if it.get("html_backlog"):
                to_backfill.append(it)
            continue
        seen_fcfs.add(norm)
        if it.get("html_backlog"):
            to_backfill.append(it)
            continue
        ts_raw = it.get("updated_time") or ""
        in_window = False
        if ts_raw:
            # Accept both str (RSS/JSON) and datetime (DB row via _row_to_item)
            if isinstance(ts_raw, datetime):
                ts = ts_raw if ts_raw.tzinfo else ts_raw.replace(tzinfo=timezone.utc)
                in_window = ts >= cutoff
            else:
                try:
                    ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    in_window = ts >= cutoff
                except (ValueError, TypeError):
                    in_window = False
        if in_window:
            to_send.append(it)
        elif ts_raw:
            to_backfill.append(it)
        else:
            if it.get("origin") == "whitelist":
                it["window_status"] = "fresh_whitelist"
                to_send.append(it)
            else:
                it["window_status"] = "unknown_time"
                logger.warn(
                    "enrich: null updated_time, non-whitelist source — skipped",
                    title=it.get("title", "")[:40],
                    source=it.get("source", ""),
                )
    return to_send, to_backfill


def mark_history_only(urls: list[str], title_keys: list[str]) -> int:
    """Record backlog chapter URLs as already-seen in dispatch_claims."""
    if not urls:
        return 0
    from datetime import datetime, timezone, timedelta
    from app.db import get_supabase

    expires = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()
    rows = [
        {"chapter_url": u, "title_key": tk or "unknown", "expires_at": expires}
        for u, tk in zip(urls, title_keys)
        if u
    ]
    if not rows:
        return 0
    try:
        get_supabase().table("dispatch_claims").upsert(
            rows, on_conflict="chapter_url"
        ).execute()
        return len(rows)
    except Exception as e:
        logger.warn("mark_history_only failed", err=str(e))
        return 0


def backfill_dispatch_history(items: list[dict], instance_id: str) -> int:
    """Silently record backlog chapter URLs as already-dispatched so they're
    never notified later. Used for HTML-scraped backlog chapters."""
    urls = [it.get("url") or it.get("chapter_url") for it in items if (it.get("url") or it.get("chapter_url"))]
    tks = [it.get("title_key", "unknown") for it in items if (it.get("url") or it.get("chapter_url"))]
    if not urls:
        return 0
    return mark_history_only(urls, tks)