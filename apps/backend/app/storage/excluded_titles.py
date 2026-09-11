"""Excluded-titles storage (RSS "Exclude" feature).

Mirror of whitelist.py but inverse: a title here is REMOVED from the /rss
feed and SKIPPED by the cron collector so it is never scraped/dispatched.

Keyed by composite (title_key, source); source='all' blocks every source.

ponytail: cover/series_url here are bloat — canonical is series_meta.cover
(title_key, source) (see 042_db_audit_fix.sql fix 6). JOIN series_meta at
read time (rss_service sm>it>wl) instead of duplicating. Kept for
back-compat list_excluded_titles fast path; idx_excluded_titles_source
speeds the LIKE '%' || VORATOON_COVER_BUCKET || '%X-Amz-%' scan which is always
source-filtered (source='voratoon').
"""
from __future__ import annotations

import time
from threading import Lock
from typing import Optional

from app.db import get_supabase
from app.logger import get_logger
from app.utils.text import slugify_title_key

logger = get_logger("storage:excluded-titles")

# ponytail: single source from config, hardcode drifts when new source added
from app.config import settings as _cfg
_VALID_SOURCES = ("all", "ikiru", "shinigami", "voratoon")


def _norm_source(src: str) -> str:
    s = (src or "all").strip().lower()
    return s if s in _VALID_SOURCES else "all"


# In-memory cache: load_excluded_keys is called in hot paths (rss, collect).
# DB round-trip ~0.3s; cache 30s. Exclude changes are rare (manual button),
# so staleness is fine.
_CACHE: set[tuple[str, str]] | None = None
_CACHE_TS: float = 0.0
_CACHE_TTL = 30.0
_LOCK = Lock()


def load_excluded_keys(force: bool = False) -> set[tuple[str, str]]:
    """Return set of (title_key, source) pairs that are excluded.

    Includes an implicit (title_key, 'all') expansion so callers can check
    either the exact (title_key, source) or a universal 'all' rule with a
    single set membership test.
    """
    global _CACHE, _CACHE_TS
    now = time.monotonic()
    if not force and _CACHE is not None and (now - _CACHE_TS) < _CACHE_TTL:
        return _CACHE
    with _LOCK:
        now = time.monotonic()
        if not force and _CACHE is not None and (now - _CACHE_TS) < _CACHE_TTL:
            return _CACHE
        try:
            rows = (
                get_supabase()
                .table("excluded_titles")
                .select("title_key, source")
                .execute()
            )
            keys: set[tuple[str, str]] = set()
            for r in (rows.data or []):
                tk = slugify_title_key(str(r.get("title_key") or ""))
                src = _norm_source(str(r.get("source") or "all"))
                if tk:
                    keys.add((tk, src))
            _CACHE = keys
            _CACHE_TS = now
            return keys
        except Exception as e:
            logger.error("load_excluded_keys failed", exc=e)
            # First call + DB error → empty set (don't mask outage with stale data)
            return _CACHE if _CACHE is not None else set()


def is_excluded(title_key: str, source: str) -> bool:
    """True if title_key is excluded for `source` OR for 'all'."""
    tk = slugify_title_key(title_key)
    if not tk:
        return False
    keys = load_excluded_keys()
    return (tk, _norm_source(source)) in keys or (tk, "all") in keys


def add_excluded_title(
    title_key: str,
    title: Optional[str] = None,
    source: str = "all",
    cover: Optional[str] = None,
    series_url: Optional[str] = None,
    reason: str = "excluded",
    is_completed: bool = False,
) -> dict:
    """Upsert an excluded-title row (idempotent via unique (title_key,source)).

    reason: 'excluded' (manual hide) vs 'completed' (tamat). Both filtered dari RSS.
    is_completed: true = TAMAT badge di /recent. ponytail: 2 kolom tapi 1 semantics, keep both for idx + legacy.
    """
    tk = slugify_title_key(title_key)
    if not tk:
        return {"status": "error", "error": "title_key required"}
    src = _norm_source(source)
    # normalize reason
    reason = (reason or "excluded").strip().lower()
    if reason not in ("excluded", "completed"):
        reason = "excluded"
    if reason == "completed":
        is_completed = True
    try:
        payload = {"title_key": tk, "source": src, "reason": reason, "is_completed": is_completed}
        if title is not None:
            payload["title"] = title
        if cover is not None:
            payload["cover"] = cover
        if series_url is not None:
            payload["series_url"] = series_url
        get_supabase().table("excluded_titles").upsert(
            payload, on_conflict="title_key,source"
        ).execute()
        global _CACHE_TS
        _CACHE_TS = 0.0  # invalidate cache
        # Invalidate the RSS response cache so excluded titles disappear
        # immediately instead of waiting for the 30s TTL.
        try:
            from app.api import rss as _rss_mod
            _rss_mod.invalidate_rss_cache()
        except Exception:
            pass
        return {"status": "ok", "title_key": tk, "source": src}
    except Exception as e:
        # Fallback if migration 065 not yet applied live (column missing) — retry without new cols
        if "reason" in str(e) or "is_completed" in str(e):
            try:
                payload2 = {"title_key": tk, "source": src}
                if title is not None:
                    payload2["title"] = title
                if cover is not None:
                    payload2["cover"] = cover
                if series_url is not None:
                    payload2["series_url"] = series_url
                # encode completed as title prefix fallback until migration lands
                if is_completed and title is not None:
                    payload2["title"] = f"[COMPLETED] {title}"
                get_supabase().table("excluded_titles").upsert(
                    payload2, on_conflict="title_key,source"
                ).execute()
                _CACHE_TS = 0.0
                try:
                    from app.api import rss as _rss_mod
                    _rss_mod.invalidate_rss_cache()
                except Exception:
                    pass
                logger.warn("add_excluded_title fallback without reason/is_completed (migration pending)", err=str(e)[:120])
                return {"status": "ok", "title_key": tk, "source": src, "fallback": True}
            except Exception as e2:
                logger.error("add_excluded_title fallback failed", exc=e2)
                return {"status": "error", "error": "internal error"}
        logger.error("add_excluded_title failed", exc=e)
        return {"status": "error", "error": "internal error"}


def remove_excluded_title(title_key: str, source: str = "all") -> dict:
    """Delete an excluded-title row."""
    tk = slugify_title_key(title_key)
    if not tk:
        return {"status": "error", "error": "title_key required"}
    src = _norm_source(source)
    try:
        get_supabase().table("excluded_titles").delete().eq(
            "title_key", tk
        ).eq("source", src).execute()
        global _CACHE_TS
        _CACHE_TS = 0.0
        try:
            from app.api import rss as _rss_mod
            _rss_mod.invalidate_rss_cache()
        except Exception:
            pass
        return {"status": "ok", "title_key": tk, "source": src}
    except Exception as e:
        logger.error("remove_excluded_title failed", exc=e)
        return {"status": "error", "error": "internal error"}


def list_excluded_titles() -> list[dict]:
    """Return all excluded-title rows (for the dashboard list)."""
    try:
        rows = (
            get_supabase()
            .table("excluded_titles")
            .select("id, title_key, title, source, created_at, cover, series_url, reason, is_completed")
            .order("created_at", desc=True)
            .execute()
        )
        return list(rows.data or [])
    except Exception as e:
        # Fallback for DBs where cover/series_url/reason not yet migrated (fresh local DB)
        if any(k in str(e) for k in ("cover", "series_url", "reason", "is_completed")):
            try:
                rows = (
                    get_supabase()
                    .table("excluded_titles")
                    .select("id, title_key, title, source, created_at, cover, series_url")
                    .order("created_at", desc=True)
                    .execute()
                )
                return list(rows.data or [])
            except Exception:
                try:
                    rows = (
                        get_supabase()
                        .table("excluded_titles")
                        .select("id, title_key, title, source, created_at")
                        .order("created_at", desc=True)
                        .execute()
                    )
                    return list(rows.data or [])
                except Exception:
                    pass
        logger.error("list_excluded_titles failed", exc=e)
        return []


def exclude_all_by_source(source: str) -> dict:
    """Exclude every title currently present in `recent_chapters` for `source`.

    Used by the FE "Exclude all <source>" button. Returns count excluded.

    Guarantees every inserted row has title_key + title populated, plus
    cover + series_url from the best available source:
    - recent_chapters (first, most up-to-date)
    - whitelist fallback
    - title derived from series_url slug as last resort
    """
    src = _norm_source(source)
    if src == "all":
        return {"status": "error", "error": "source required (cannot bulk-exclude 'all')"}
    try:
        rows = (
            get_supabase()
            .table("recent_chapters")
            .select("title_key, title, series_url, cover")
            .eq("source", src)
            .limit(5000)
            .execute()
        )
        seen: dict[str, dict] = {}
        for r in (rows.data or []):
            tk = slugify_title_key(str(r.get("title_key") or ""))
            if tk and tk not in seen:
                seen[tk] = {
                    "title": str(r.get("title") or "").strip(),
                    "series_url": str(r.get("series_url") or "").strip(),
                    "cover": str(r.get("cover") or "").strip(),
                }

        # Enrich missing titles from whitelist
        missing_titles = [tk for tk, v in seen.items() if not v["title"]]
        if missing_titles:
            try:
                meta = (
                    get_supabase()
                    .table("whitelist")
                    .select("title_key, title")
                    .in_("title_key", missing_titles)
                    .execute()
                )
                for m in (meta.data or []):
                    tk = slugify_title_key(str(m.get("title_key") or ""))
                    if tk in seen and not seen[tk]["title"]:
                        t = str(m.get("title") or "").strip()
                        if t:
                            seen[tk]["title"] = t
            except Exception:
                pass

        # Fallback: derive title from series_url slug
        for tk, v in seen.items():
            if not v["title"] and v["series_url"]:
                slug = v["series_url"].rstrip("/").split("/")[-1]
                if slug:
                    v["title"] = slug.replace("-", " ").replace("_", " ").strip().title()

        # Batch upsert (single DB round-trip instead of N)
        batch = []
        for tk, v in seen.items():
            title = v["title"] or None
            payload = {"title_key": tk, "source": src, "title": title}
            if v.get("cover"):
                payload["cover"] = v["cover"]
            if v.get("series_url"):
                payload["series_url"] = v["series_url"]
            batch.append(payload)
        
        total_inserted = 0
        if batch:
            CHUNK = 50
            try:
                for i in range(0, len(batch), CHUNK):
                    chunk = batch[i:i + CHUNK]
                    get_supabase().table("excluded_titles").upsert(
                        chunk, on_conflict="title_key,source"
                    ).execute()
                    total_inserted += len(chunk)
                global _CACHE_TS
                _CACHE_TS = 0.0
                try:
                    from app.api import rss as _rss_mod
                    _rss_mod._RSS_CACHE.clear()
                except Exception:
                    pass
            except Exception as e:
                logger.error("exclude_all_by_source batch upsert failed", exc=e)
                return {"status": "error", "error": "internal error"}
        
        return {"status": "ok", "excluded": total_inserted, "source": src}
    except Exception as e:
        logger.error("exclude_all_by_source failed", exc=e)
        return {"status": "error", "error": "internal error"}
