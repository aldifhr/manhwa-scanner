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

def _composite_key(r: dict) -> tuple[str, str, str] | None:
    tk = r.get("title_key") or ""
    src = r.get("source") or ""
    cn = _norm_chapter_num(r.get("chapter_num"))
    if not tk or not src:
        return None
    if cn is None:
        return (tk, src, "oneshot")
    return (tk, src, cn)

def batch_insert_recent_chapters(rows: list[dict]) -> dict[str, int]:
    """Batch insert chapters. Returns {inserted, failed, deduped} counts."""
    if not rows:
        return {"inserted": 0, "failed": 0, "deduped": 0}
    inserted = failed = 0
    allowed = {
        "chapter_url",
        "title_key",
        "title",
        "chapter",
        "chapter_num",
        "source",
        "cover",
        "series_url",
        "updated_time",
        "release_date",
        "origin",
        "description",
        "type",
        "genres",
        "rating",
    }
    _wl_origins_local = _get_wl_origins()
    cleaned = []
    for row in rows:
        if not row.get("chapter_url"):
            continue
        _raw_origin = row.get("origin") or row.get("type") or ""
        _src = row.get("source") or ""
        _norm = normalize_origin(_raw_origin)
        if not _norm and _src:
            _norm = normalize_origin(_src)
        if not _norm:
            _norm = ""
        _tk_override = str(row.get("title_key") or "").strip()
        if _tk_override and (_tk_override, _src) in _wl_origins_local:
            _norm = _wl_origins_local[(_tk_override, _src)]
        if not row.get("type") and _norm:
            _origin_to_type = {"KR": "manhwa", "CN": "manhua", "JP": "manga"}
            row["type"] = _origin_to_type.get(_norm, "")
        _r = {k: row.get(k) for k in allowed if k != "origin"}
        for _k in ("rating", "description", "type"):
            if _r.get(_k) is None:
                _r[_k] = ""
        if _r.get("genres") is None:
            _r["genres"] = []
        for _k in ("chapter_num", "rating"):
            _v = _r.get(_k)
            if _v is None or _v == "":
                _r[_k] = 0.0
            else:
                try:
                    _r[_k] = float(_v)
                except (TypeError, ValueError):
                    _r[_k] = 0.0
        _r["chapter_url"] = row["chapter_url"]
        cleaned.append(_r)
    to_upsert: list[dict] = []
    try:
        # Backfill missing covers from series_meta (collect_whitelisted_shinigami sets cover=None)
        _need_cover = [r for r in cleaned if not r.get("cover")]
        if _need_cover:
            _tks = list({(r.get("title_key",""), r.get("source","")) for r in _need_cover if r.get("title_key")})
            if _tks:
                _covers = {}
                for i in range(0, len(_tks), 100):
                    chunk = _tks[i:i+100]
                    _sb = get_supabase()
                    try:
                        for src in set(s for _, s in chunk):
                            _src_tks = [tk for tk, s in chunk if s == src]
                            _res = _sb.table("series_meta").select("title_key,source,cover").in_("title_key", _src_tks).eq("source", src).limit(len(_src_tks)*2).execute()
                            for row in _res.data or []:
                                _covers[(row["title_key"], src)] = row.get("cover")
                    except Exception as _e:
                        logger.warn("cover backfill query failed — chapter inserted without cover, retry next cron", err=str(_e)[:160], srcs=list(set(s for _, s in chunk)))
                        try:
                            from app.metrics_prometheus import COVER_BACKFILL_ERRORS
                            for s in set(s for _, s in chunk):
                                COVER_BACKFILL_ERRORS.labels(source=s).inc()
                        except Exception:
                            pass
                for r in cleaned:
                    if not r.get("cover"):
                        r["cover"] = _covers.get((r.get("title_key",""), r.get("source","")), "")
                        if r["cover"] is None:
                            r["cover"] = ""
        _seen_url: set[str] = set()
        _seen_ch: set[tuple[str, str, str]] = set()
        _uniq: list[dict] = []
        for r in cleaned:
            u = r.get("chapter_url")
            if u in _seen_url:
                continue
            _ck = _composite_key(r)
            if _ck and _ck in _seen_ch:
                continue
            _seen_url.add(u)
            if _ck:
                _seen_ch.add(_ck)
            _uniq.append(r)
        to_upsert = _uniq
        if to_upsert:
            # Cross-check against rows already in recent_chapters (the 24h
            # window; prune runs before this in the pipeline):
            #  - same chapter_url present → keep the ORIGINAL updated_time
            #    (ikiru renewing an old chapter's <time> must NOT re-fresh the
            #    feed entry); only non-time metadata is refreshed below.
            #  - same (title_key, source, chapter_num) with a DIFFERENT
            #    chapter_url → URL-rotated re-touch / duplicate release → skip
            #    entirely (no second RSS row).
            existing_urls, existing_ch = _load_existing_rc(to_upsert)
            new_rows: list[dict] = []
            touch_rows: list[dict] = []
            for r in to_upsert:
                if r["chapter_url"] in existing_urls:
                    r["scan_status"] = "updated"
                    r["scan_reason"] = "metadata refreshed"
                    r["confidence_score"] = 100
                    touch_rows.append(r)
                elif _composite_key(r) in existing_ch:
                    continue
                else:
                    r["scan_status"] = "new"
                    r["scan_reason"] = "new chapter"
                    r["confidence_score"] = 100
                    new_rows.append(r)
            # Chunk upserts: Supabase/PostgREST returns HTTP 400
            # ("JSON could not be generated") on a single large .insert() call
            # (~150+ rows). Insert genuinely-new rows (with their real
            # updated_time).
            CHUNK = 50
            # inserted/failed already init at top — reuse
            for i in range(0, len(new_rows), CHUNK):
                chunk_rows = new_rows[i : i + CHUNK]
                _retry = 0
                while _retry < 2:
                    try:
                        from app.db_adapter import get_pool_stats as _gps
                        _ps_before = _gps()
                        logger.debug("batchInsert chunk start", chunk=f"{i//CHUNK}", rows=len(chunk_rows), pool=_ps_before, retry=_retry)
                        get_supabase().table("recent_chapters").upsert(
                            chunk_rows, on_conflict="chapter_url"
                        ).execute()
                        inserted += len(chunk_rows)
                        logger.debug("batchInsert chunk ok", chunk=f"{i//CHUNK}", inserted=inserted)
                        break
                    except Exception as e:
                        from app.db_adapter import get_pool_stats as _gps2
                        _ps_after = _gps2()
                        msg = str(e).lower()
                        if "rc_composite" in msg or "idx_recent_chapters_composite_unique" in msg or "composite_unique" in msg:
                            logger.info("batchInsert race rc_composite benign, skip", chunk=f"{i//CHUNK}", pool=_ps_after)
                            break
                        if ("already closed" in msg or "pool closed" in msg) and _retry == 0:
                            logger.debug("batchInsert pool closed retry", chunk=f"{i//CHUNK}", pool=_ps_after)
                            import time as _t
                            _t.sleep(0.5)
                            _retry += 1
                            continue
                        failed += len(chunk_rows)
                        # harden: log constraint + first row keys so pool closed / constraint errors are diagnosable without replay
                        logger.error(
                            "batchInsertRecentChapters chunk failed — data loss",
                            exc=e,
                            exc_info=True,
                            range=f"{i}-{i+len(chunk_rows)}",
                            constraint="title_key,source,chapter_num",
                            first_keys=list(chunk_rows[0].keys()) if chunk_rows else [],
                            first_url=str(chunk_rows[0].get("chapter_url") or "")[:120] if chunk_rows else "",
                            pool=_ps_after,
                        )
                        break
            # touch + backfill still run even on partial failure — don't lose metadata refresh
            # Existing rows: refresh NON-time metadata only — never
            # updated_time — so an ikiru re-touch (renewed <time>) can't keep
            # an old chapter pinned to the top of the 24h feed. PostgREST
            # upsert only writes the provided columns on conflict, so omitting
            # updated_time preserves the original release time.
            if touch_rows:
                _touch_rows = []
                for r in touch_rows:
                    _t = {
                        "chapter_url": r["chapter_url"],
                        "scan_status": "updated",
                        "scan_reason": "metadata refreshed",
                        "confidence_score": 100,
                    }
                    for k in ("title_key", "title", "chapter", "chapter_num", "source", "cover", "series_url", "origin", "description", "rating", "genres", "type", "release_date"):
                        v = r.get(k)
                        if v not in (None, "", []):
                            _t[k] = v
                    _touch_rows.append(_t)
                # db_adapter requires every row in a batch to share the same
                # column set; a row missing chapter_num (sparse touch) fails
                # the whole 50-row chunk. Group by column-set signature so
                # each batch is uniform — no NULL-filling (an upsert with
                # explicit None would overwrite real values on conflict).
                _sig_groups: dict[frozenset, list[dict]] = {}
                for r in _touch_rows:
                    _sig_groups.setdefault(frozenset(r.keys()), []).append(r)
                _uniform_chunks = [
                    rows[i : i + CHUNK]
                    for rows in _sig_groups.values()
                    for i in range(0, len(rows), CHUNK)
                ]
                for chunk_rows in _uniform_chunks:
                    _t_retry = 0
                    while _t_retry < 2:
                        try:
                            get_supabase().table("recent_chapters").upsert(
                                chunk_rows, on_conflict="chapter_url"
                            ).execute()
                            break
                        except Exception as e:
                            msg = str(e).lower()
                            if ("already closed" in msg or "pool closed" in msg) and _t_retry == 0:
                                try:
                                    from app.db_adapter import get_pool_stats as _gps3
                                    _ps_touch = _gps3()
                                except Exception:
                                    _ps_touch = {}
                                logger.debug("batchInsert touch pool closed retry", pool=_ps_touch)
                                import time as _t
                                _t.sleep(0.5)
                                _t_retry += 1
                                continue
                            failed += len(chunk_rows)
                            logger.error(
                                "batchInsertRecentChapters touch chunk failed — data loss",
                                exc=e,
                                exc_info=True,
                                range=f"{len(chunk_rows)} rows",
                                constraint="chapter_url",
                                first_keys=list(chunk_rows[0].keys()) if chunk_rows else [],
                                first_url=str(chunk_rows[0].get("chapter_url") or "")[:120] if chunk_rows else "",
                            )
                            break
            if len(to_upsert) < len(cleaned):
                logger.info("batchInsertRecentChapters dedup", before=len(rows), after=len(to_upsert))
            if len(new_rows) < len(to_upsert):
                logger.info(
                    "batchInsertRecentChapters re-touch/dupe skipped",
                    total=len(to_upsert),
                    inserted=inserted,
                )
        else:
            logger.info("batchInsertRecentChapters: nothing to upsert")
        # FIX: backfill origin for existing rows that have EMPTY origin
        # (older rows inserted before origin was populated).
        # P2: do this as a single bulk upsert, not N individual .update() calls
        # (avoids the N+1 query anti-pattern when hundreds of rows qualify).
        try:
            # Chunk the .in_() lookup (same 100-URL limit as the existing-check
            # above) to avoid "URL component 'query' too long" on large batches.
            existing_rows: list[dict] = []
            all_urls = [r["chapter_url"] for r in cleaned if r.get("chapter_url")]
            for i in range(0, len(all_urls), 100):
                chunk_urls = all_urls[i : i + 100]
                try:
                    res = (
                        get_supabase()
                        .table("recent_chapters")
                        .select("chapter_url, origin")
                        .in_("chapter_url", chunk_urls)
                        .execute()
                    )
                    existing_rows.extend(res.data or [])
                except Exception as e:
                    logger.error("origin backfill lookup chunk failed", exc=e, exc_info=True)
            # Build lookup maps from cleaned rows
            incoming_origin: dict[str, str] = {}
            incoming_title_key: dict[str, str] = {}
            for d in cleaned:
                if d.get("origin"):
                    incoming_origin[d["chapter_url"]] = d["origin"]
                if d.get("title_key"):
                    incoming_title_key[d["chapter_url"]] = d["title_key"]
            updates = [
                {
                    "chapter_url": er["chapter_url"],
                    "origin": incoming_origin[er["chapter_url"]],
                    "title_key": incoming_title_key.get(er["chapter_url"]) or er.get("title_key") or "",
                }
                for er in existing_rows
                if not er.get("origin") and er.get("chapter_url") in incoming_origin
            ]
            # Bulk upsert in chunks (reuse the 50-row safe chunk size)
            CHUNK = 50
            for i in range(0, len(updates), CHUNK):
                chunk_rows = updates[i : i + CHUNK]
                if chunk_rows:
                    get_supabase().table("recent_chapters").upsert(
                        chunk_rows, on_conflict="chapter_url"
                    ).execute()
        except Exception as e:
            logger.error("batchInsertRecentChapters backfill failed", exc=e, exc_info=True)
            failed += len(updates) if 'updates' in locals() else 0
    except Exception as e:
        logger.error("batchInsertRecentChapters failed", exc=e, exc_info=True, constraint="chapter_url", first_keys=list(cleaned[0].keys()) if cleaned else [])
        failed = len(cleaned) if 'cleaned' in locals() else 0
    finally:
        if failed:
            logger.error("batchInsert partial_success", inserted=inserted, failed=failed, total=len(rows))
    return {"inserted": inserted, "failed": failed, "deduped": len(rows) - len(to_upsert) if 'to_upsert' in locals() else 0}
    # P1 cache-share: invalidate RSS cache across api/cron via Redis pub key
    try:
        from app.tasks import _get_redis as _gr
        _gr().setex("rss:invalidate", 30, "1")
    except Exception:
        pass

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
    }
    su = item.get("series_url")
    if su:
        item["series_url"] = normalize_shinigami_url(su) or su
    for fld in ("url", "chapter_url", "cover"):
        v = item.get(fld)
        if isinstance(v, str) and "shinigami.asia" in v:
            item[fld] = normalize_shinigami_url(v) or v
    return item
