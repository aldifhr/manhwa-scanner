"""Whitelist service — CRUD + metadata joins for whitelist entries.

This module is now a thin orchestration layer. Dispatch history lives in
dispatch_history.py; enrichment helpers live in whitelist_enrichment.py.
All function signatures are preserved for backward compatibility.
"""
from __future__ import annotations

import re

from app.logger import get_logger
from app.storage import whitelist as wl_store
from app.utils.text import normalize_title_key, normalize_shinigami_url

logger = get_logger("services:whitelist")

# Re-export dispatch history (lives in dispatch_history.py)
from app.services.dispatch_history import get_dispatch_history

# Re-export enrichment helpers (lives in whitelist_enrichment.py)
from app.services.whitelist_enrichment import enrich_whitelist_entry, build_whitelist_mapped_row

__all__ = [
    "get_dispatch_history",
    "get_whitelist",
    "post_whitelist",
    "delete_whitelist",
    "patch_whitelist",
    "normalize_whitelist_urls",
    "auto_cleanup_stale_whitelist",
]


def get_whitelist(source: str = "", title: str = "", page: int = 1, page_size: int = 100, merge: bool = True) -> dict:
    """Get whitelist with metadata joins. DB-side pagination for source/title filters."""
    from app.services.whitelist_repo import fetch_whitelist_rows

    try:
        page = max(1, int(page))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = max(1, min(10000, int(page_size)))
    except (TypeError, ValueError):
        page_size = 100

    rows, total, sb, _db_paginated_flag = fetch_whitelist_rows(
        source=source, title=title, page=page, page_size=page_size, merge=merge
    )
    all_tks = [r.get("title_key") for r in rows if r.get("title_key")]
    offset = (page - 1) * page_size
    total_pages = (total + page_size - 1) // page_size if page_size else 1
    has_more = page * page_size < total
    rc_map = {}
    rc_series_by_title: dict[str, str] = {}

    cand_keys: set[str] = set()
    for r in rows:
        tk = r.get("title_key", "")
        if tk:
            cand_keys.add(tk)
            cand_keys.add(tk.replace(" ", "-"))
        su = (r.get("series_url") or r.get("url") or "").rstrip("/").split("/")[-1]
        if su:
            cand_keys.add(su)

    def _q_recent():
        q = sb.table("recent_chapters").select("title_key, title, source, cover, origin, updated_time, series_url")
        if all_tks:
            q = q.in_("title_key", all_tks)
        return q.execute()

    def _q_meta():
        if not cand_keys:
            return None
        return sb.table("whitelist").select("title_key, description, cover").in_("title_key", list(cand_keys)).execute()

    def _q_dh():
        tks = [r.get("title_key", "") for r in rows if r.get("title_key")]
        if not tks:
            return None
        return sb.table("dispatch_history").select("title_key, sent_at").in_("title_key", tks).execute()

    rc_rows = _q_recent()
    meta_rows = _q_meta()
    dh_rows = _q_dh()

    if rc_rows and rc_rows.data:
        for rc in rc_rows.data:
            tk = rc.get("title_key")
            src = rc.get("source") or ""
            if tk and (tk, src) not in rc_map:
                rc_map[(tk, src)] = rc
            t = (rc.get("title") or "").strip().lower()
            su = rc.get("series_url") or ""
            if t and su and t not in rc_series_by_title:
                rc_series_by_title[t] = su
    meta_desc: dict[str, str] = {}
    meta_cover: dict[str, str] = {}
    try:
        _meta_data = (meta_rows.data if (meta_rows and getattr(meta_rows, "data", None)) else [])
        for m in _meta_data:
            d = m.get("description")
            if d:
                meta_desc[m.get("title_key", "")] = d
            c = m.get("cover")
            if c:
                meta_cover[m.get("title_key", "")] = c
    except Exception:
        pass
    last_notified: dict[str, str] = {}
    try:
        _dh_data = (dh_rows.data if (dh_rows and getattr(dh_rows, "data", None)) else [])
        for d in _dh_data:
            tk = d.get("title_key", "")
            ts = d.get("sent_at") or ""
            if tk and (tk not in last_notified or ts > last_notified[tk]):
                last_notified[tk] = ts
    except Exception:
        pass

    mapped = [build_whitelist_mapped_row(r, rc_map, meta_desc, meta_cover, last_notified) for r in rows]

    # ---- Dedup (extracted) ----
    from app.services.whitelist_dedup import dedup_whitelist

    _is_db_paginated = bool(_db_paginated_flag)
    if merge:
        deduped = dedup_whitelist(mapped, _canonical_of)
    else:
        deduped = mapped

    if _is_db_paginated:
        total = total  # already count from repo
        total_pages = (total + page_size - 1) // page_size if page_size else 1
        has_more = page * page_size < total
        paged_out = deduped
    else:
        total = len(deduped)
        total_pages = (total + page_size - 1) // page_size if page_size else 1
        has_more = page * page_size < total
        offset = (page - 1) * page_size
        paged_out = deduped[offset:offset + page_size]

    paged_out.sort(
        key=lambda x: (x.get("last_chapter") or x.get("last_notified") or "", x.get("title") or ""),
        reverse=True,
    )
    return {
        "success": True,
        "data": {
            "results": paged_out,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "limit": page_size,
            "totalPages": total_pages,
            "hasMore": has_more,
            "has_more": has_more,
        },
    }


def post_whitelist(title: str, url: str, source: str = "ikiru", body: dict | None = None) -> dict:
    """Add a whitelist entry with enrichment."""

    title_key = body.get("title_key") or "" if body else ""
    if not title_key and url:
        u = url.rstrip("/")
        if "/manga/" in u:
            title_key = u.split("/manga/")[-1].split("/")[0]
        elif "/series/" in u or "/chapter/" in u:
            _m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", u)
            if _m:
                try:
                    from app.scrapers import shinigami as _sh_get
                    _ser = _sh_get.get_shinigami_series(_m.group(1))
                    if _ser and _ser.get("title"):
                        title_key = normalize_title_key(_ser["title"])
                except Exception:
                    pass
            if not title_key:
                title_key = ""
        else:
            title_key = u.split("/")[-1]
        if title_key.startswith("chapter-"):
            title_key = ""
    if not title_key:
        title_key = normalize_title_key(title)

    entry = {"title": title, "title_key": title_key, "source": source}
    if body:
        for f in ("cover", "rating", "origin", "genres", "description"):
            v = body.get(f)
            if v is None or v == "":
                continue
            # Reject obvious placeholder/sentinel junk the FE sometimes sends
            # (e.g. description="d", genres=["a"]) so enrich_whitelist_entry can
            # fetch the real metadata from the source API instead of persisting
            # the garbage.
            if f == "description" and isinstance(v, str) and len(v.strip()) < 4:
                continue
            if f == "genres" and isinstance(v, list) and (
                len(v) == 0 or (len(v) == 1 and str(v[0]).strip().lower() in ("a", "x", "n/a"))
            ):
                continue
            entry[f] = v
        _su = body.get("seriesUrl") or body.get("series_url") or ""
        if isinstance(_su, str) and _su.strip():
            entry["series_url"] = _su.strip()

    # Enrich missing fields
    entry = enrich_whitelist_entry(entry, url, source, title)

    res = wl_store.add_whitelist_entries([entry])
    return res


def delete_whitelist(title_key: str = "", source: str = "", id: str = "", title: str = "", url: str = "") -> dict:
    """Delete a whitelist entry (and its recent_chapters rows) by ANY key.

    Matches on id OR title_key OR canonical_title_key OR title (ILIKE) OR url
    (ILIKE), plus source when provided. Returns {"status":"ok","deleted":N} with
    the real row count, or raises KeyError-style via returning a 404-shaped dict
    when nothing matched (caller maps to 404). Never returns a silent 200 no-op.

    Also deletes the matching recent_chapters rows so the FE reader (which
    materializes whitelist from recent_chapters) reflects the deletion instead of
    showing a stale entry that lives only in recent_chapters.
    """
    from app.db import get_supabase, get_conn, put_conn
    import json as _json

    sb = get_supabase()
    _tk = (title_key or "").strip()
    _src = (source or "").strip()
    _id = (id or "").strip()
    _title = (title or "").strip()
    _url = (url or "").strip()

    logger.info(
        "delete_whitelist called",
        id=_id[:16] if _id else "",
        title_key=_tk,
        title=_title[:40] if _title else "",
        url=_url[:60] if _url else "",
        source=_src,
    )

    # Build a permissive OR filter for the whitelist table.
    # We can't do a single .or_() easily across all column types with db_adapter,
    # so we try each key and union the matched ids.
    matched_ids: set[str] = set()
    try:
        if _id:
            r = sb.table("whitelist").select("id, title_key, source").eq("id", _id).execute()
            for x in (r.data or []):
                matched_ids.add(x["id"])
        if _tk:
            r = sb.table("whitelist").select("id, title_key, source").eq("title_key", _tk).execute()
            for x in (r.data or []):
                matched_ids.add(x["id"])
            # canonical variant (space<->dash)
            r = sb.table("whitelist").select("id, title_key, source").eq("title_key", _tk.replace(" ", "-")).execute()
            for x in (r.data or []):
                matched_ids.add(x["id"])
            r = sb.table("whitelist").select("id, title_key, source").eq("title_key", _tk.replace("-", " ")).execute()
            for x in (r.data or []):
                matched_ids.add(x["id"])
        if _title:
            # Escape LIKE wildcards to avoid over-match + use exact title_key fallback first
            _esc_title = _title.replace("%", r"\%").replace("_", r"\_")
            # Prefer exact title_key match via normalized title before ILIKE
            from app.utils.text import normalize_title_key as _ntk_del
            _ntk_title = _ntk_del(_title)
            if _ntk_title:
                r = sb.table("whitelist").select("id, title_key, source").eq("title_key", _ntk_title).execute()
                for x in (r.data or []):
                    matched_ids.add(x["id"])
            r = sb.table("whitelist").select("id, title_key, source").ilike("title", f"%{_esc_title}%").execute()
            for x in (r.data or []):
                matched_ids.add(x["id"])
        if _url:
            _esc_url = _url.split('/')[-1].replace("%", r"\%").replace("_", r"\_")
            r = sb.table("whitelist").select("id, title_key, source").ilike("url", f"%{_esc_url}%").execute()
            for x in (r.data or []):
                matched_ids.add(x["id"])
    except Exception as _e:
        logger.warn("delete_whitelist: match query failed", err=str(_e)[:160])

    # Apply source filter if provided.
    if _src:
        # Re-fetch matched rows' sources to filter (cheap; matched_ids is small).
        _keep: set[str] = set()
        try:
            for mid in matched_ids:
                r = sb.table("whitelist").select("id, source").eq("id", mid).execute()
                for x in (r.data or []):
                    if (x.get("source") or "") == _src:
                        _keep.add(x["id"])
            matched_ids = _keep
        except Exception as _e:
            logger.warn("delete_whitelist: source filter failed", err=str(_e)[:120])

    deleted = 0
    if matched_ids:
        try:
            rr = sb.table("whitelist").delete().in_("id", list(matched_ids)).execute()
            deleted += len(rr.data or [])
        except Exception as _e:
            logger.warn("delete_whitelist: whitelist delete failed", err=str(_e)[:160])

    # Also delete matching recent_chapters rows (FE reader source).
    # Match by title_key (space/dash variants) OR title ILIKE OR url, plus source.
    rc_deleted = 0
    try:
        conn = get_conn()
        cur = conn.cursor()
        _conds = []
        _params: list = []
        if _tk:
            _conds.append("title_key=%s OR title_key=%s")
            _params.extend([_tk, _tk.replace("-", " ")])
        if _title:
            _esc_t = _title.replace("%", r"\%").replace("_", r"\_")
            _conds.append("title ILIKE %s")
            _params.append(f"%{_esc_t}%")
        if _url:
            _esc_u = _url.replace("%", r"\%").replace("_", r"\_")
            _conds.append("series_url ILIKE %s OR url ILIKE %s OR chapter_url ILIKE %s")
            _params.extend([f"%{_esc_u}%", f"%{_esc_u}%", f"%{_esc_u}%"])
        if _conds:
            _where = " OR ".join(_conds)
            if _src:
                _where = f"({_where}) AND source=%s"
                _params.append(_src)
            cur.execute(f"DELETE FROM recent_chapters WHERE {_where}", _params)
            rc_deleted = cur.rowcount
            conn.commit()
        put_conn(conn)
    except Exception as _e:
        logger.warn("delete_whitelist: recent_chapters delete failed", err=str(_e)[:160])

    total_deleted = deleted + rc_deleted
    logger.info(
        "delete_whitelist result",
        whitelist_deleted=deleted,
        recent_chapters_deleted=rc_deleted,
        matched_ids=len(matched_ids),
    )
    if total_deleted == 0:
        return {"status": "not_found", "deleted": 0, "error": "no matching whitelist entry"}
    # Invalidate the cached whitelist so the next GET reflects the deletion
    # immediately (load_whitelist uses @ttl_cache(30s); without this the FE
    # verify step sees a stale list and reports "stillThere true").
    try:
        from app.storage import whitelist as _wl_store
        _wl_store.load_whitelist.invalidate()
    except Exception as _ie:
        logger.warn("delete_whitelist: cache invalidate failed", err=str(_ie)[:120])
    return {"status": "ok", "deleted": total_deleted, "whitelist": deleted, "recent_chapters": rc_deleted}


def patch_whitelist(title_key: str, source: str = "", updates: dict | None = None) -> dict:
    """Update mutable whitelist fields."""
    from app.db import get_supabase

    if not updates:
        return {"success": True, "updated": 0, "note": "no fields to update"}

    sb = get_supabase()
    q = sb.table("whitelist").update(updates).eq("title_key", title_key)
    if source:
        q = q.eq("source", source)
    res = q.execute()
    updated = len(res.data or []) if hasattr(res, "data") else 0
    return {"success": True, "updated": updated, "title_key": title_key}


def normalize_whitelist_urls(dry_run: bool = False) -> dict:
    """Rewrite stale shinigami hosts in whitelist + recent_chapters to current base."""
    from app.db import get_supabase as _sb

    wl_rows = _sb().table("whitelist").select("title_key,source,series_url,url,permalink,cover").execute().data or []
    rc_rows = _sb().table("recent_chapters").select("id,series_url,chapter_url,cover").execute().data or []

    def _apply(v):
        if not v or not isinstance(v, str) or "shinigami.asia" not in v:
            return v, False
        new_v = normalize_shinigami_url(v)
        return new_v, new_v != v

    wl_updates = []
    seen_wl = set()
    for r in wl_rows:
        key = (r.get("title_key"), r.get("source"))
        if key in seen_wl:
            continue
        seen_wl.add(key)
        changed = {}
        for fld in ("series_url", "url", "permalink", "cover"):
            v = r.get(fld)
            if not v:
                continue
            new_v, changed_flag = _apply(v)
            if changed_flag:
                changed[fld] = new_v
        if changed:
            wl_updates.append((key, changed))

    rc_updates = []
    seen_rc = set()
    rc_chapter_seen = {}
    for r in rc_rows:
        rid = r.get("id")
        if rid in seen_rc:
            continue
        seen_rc.add(rid)
        changed = {}
        chapter_url_patch = None
        for fld in ("series_url", "chapter_url", "cover"):
            v = r.get(fld)
            if not v:
                continue
            new_v, changed_flag = _apply(v)
            if not changed_flag:
                continue
            if fld == "chapter_url":
                chapter_url_patch = new_v
            else:
                changed[fld] = new_v
        if chapter_url_patch is not None:
            if chapter_url_patch in rc_chapter_seen:
                continue
            rc_chapter_seen[chapter_url_patch] = rid
            changed["chapter_url"] = chapter_url_patch
        if changed:
            rc_updates.append((rid, changed))

    if not dry_run:
        for (tk, src), patch in wl_updates:
            _sb().table("whitelist").update(patch).eq("title_key", tk).eq("source", src).execute()
        for rid, patch in rc_updates:
            try:
                _sb().table("recent_chapters").update(patch).eq("id", rid).execute()
            except Exception:
                pass

    return {
        "success": True,
        "dry_run": dry_run,
        "updated_whitelist": len(wl_updates),
        "updated_recent_chapters": len(rc_updates),
    }


def auto_cleanup_stale_whitelist(days: int = 30, dry_run: bool = False) -> dict:
    """Remove whitelist entries that were added >`days` ago AND have NEVER
    been notified (no dispatch_history row at all)."""
    return wl_store.auto_cleanup_stale_whitelist(days=days, dry_run=dry_run)


def _canonical_of(tk: str) -> str:
    from app.storage.canonical import canonical_of as _co
    return _co(tk)
