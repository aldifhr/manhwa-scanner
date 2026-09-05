"""Whitelist service — CRUD + metadata joins — ponytail: 751L whitelist CRUD+enrich+dedup intentional, split when file >1000L or per-route churn diverges."""
from __future__ import annotations

import re
import html

from app.logger import get_logger
from app.storage import whitelist as wl_store
from app.utils.text import normalize_title_key, normalize_shinigami_url
from app.utils.origin import normalize_origin
from app.utils.cover_scrub import scrub_cover

logger = get_logger("services:whitelist")

# Re-export dispatch history (lives in dispatch_history.py)
from app.services.dispatch_history import get_dispatch_history

__all__ = [
    "get_dispatch_history",
    "get_whitelist",
    "post_whitelist",
    "delete_whitelist",
    "patch_whitelist",
    "normalize_whitelist_urls",
    "auto_cleanup_stale_whitelist",
]


def _fetch_whitelist_rows(
    source: str = "",
    title: str = "",
    page: int = 1,
    page_size: int = 100,
    merge: bool = True,
    cursor: str | None = None,
):
    """ponytail: inlined from whitelist_repo.py (93L) — single caller, delete file when merged"""
    from app.db import get_supabase
    from app.storage import whitelist as wl_store
    try:
        page = max(1, int(page))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = max(1, min(10000, int(page_size)))
    except (TypeError, ValueError):
        page_size = 100
    use_db_pagination = bool(source or title)
    if use_db_pagination:
        try:
            sb_pg = get_supabase()
            q = sb_pg.table("whitelist").select("*", count="exact")
            if source:
                q = q.eq("source", source)
            if title:
                _t = title.replace("%", r"\%").replace("_", r"\_")
                q = q.ilike("title", f"%{_t}%")
            cnt_res = q.limit(1).execute()
            total_raw = cnt_res.count or 0
            if merge:
                q2 = sb_pg.table("whitelist").select("*")
                if source:
                    q2 = q2.eq("source", source)
                if title:
                    _t2 = title.replace("%", r"\%").replace("_", r"\_")
                    q2 = q2.ilike("title", f"%{_t2}%")
                q2 = q2.order("created_at", desc=True).limit(10000)
                rows = q2.execute().data or []
                return rows, total_raw, sb_pg, False
            else:
                if cursor:
                    q2 = sb_pg.table("whitelist").select("*")
                    if source:
                        q2 = q2.eq("source", source)
                    if title:
                        _t2 = title.replace("%", r"\%").replace("_", r"\_")
                        q2 = q2.ilike("title", f"%{_t2}%")
                    q2 = q2.lt("created_at", cursor).order("created_at", desc=True).limit(page_size)
                    rows = q2.execute().data or []
                    return rows, total_raw, sb_pg, True
                start = (page - 1) * page_size
                q2 = sb_pg.table("whitelist").select("*")
                if source:
                    q2 = q2.eq("source", source)
                if title:
                    _t2 = title.replace("%", r"\%").replace("_", r"\_")
                    q2 = q2.ilike("title", f"%{_t2}%")
                q2 = q2.order("created_at", desc=True).limit(page_size).offset(start)
                rows = q2.execute().data or []
                return rows, total_raw, sb_pg, True
        except Exception as e:
            logger.warn("whitelist_repo DB pagination failed, fallback in-memory", err=str(e)[:160])
    rows = wl_store.load_whitelist()
    if source:
        rows = [r for r in rows if (r.get("source") or "") == source]
    if title:
        _ql = title.lower()
        rows = [r for r in rows if _ql in (r.get("title", "") or "").lower()]
    from app.db import get_supabase
    sb = get_supabase()
    return rows, len(rows), sb, False

def get_whitelist(source: str = "", title: str = "", page: int = 1, page_size: int = 100, merge: bool = True, cursor: str | None = None) -> dict:
    """Get whitelist with metadata joins. DB-side pagination + cursor (keyset)."""

    try:
        page = max(1, int(page))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = max(1, min(10000, int(page_size)))
    except (TypeError, ValueError):
        page_size = 100

    rows, total, sb, _db_paginated_flag = _fetch_whitelist_rows(
        source=source, title=title, page=page, page_size=page_size, merge=merge, cursor=cursor
    )
    all_tks = [r.get("title_key") for r in rows if r.get("title_key")]
    offset = (page - 1) * page_size
    total_pages = (total + page_size - 1) // page_size if page_size else 1
    has_more = page * page_size < total

    rc_map, meta_desc, meta_cover, last_notified = _fetch_whitelist_enrichment(sb, rows, all_tks)

    mapped = [build_whitelist_mapped_row(r, rc_map, meta_desc, meta_cover, last_notified) for r in rows]

    # ponytail: dedup inlined (was whitelist_dedup.py 57L single caller)

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
        # Sort BEFORE slice already done in repo; keep order (fix sort-after-slice bug was here)
    else:
        total = len(deduped)
        total_pages = (total + page_size - 1) // page_size if page_size else 1
        has_more = page * page_size < total
        offset = (page - 1) * page_size
        deduped.sort(
            key=lambda x: (x.get("last_chapter") or x.get("last_notified") or "", x.get("title") or ""),
            reverse=True,
        )
        paged_out = deduped[offset:offset + page_size]
    next_cursor = paged_out[-1].get("created_at") if has_more and paged_out else None
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
            "nextCursor": next_cursor,
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

    # Enrich missing fields — non-blocking: insert immediately, enrich in background
    # so POST stays 0.02s instead of 0.5s (was 3 sync HTTP fetches to ikiru/voratoon/shinigami).
    _needs_enrich = not entry.get("description") or not entry.get("cover") or not entry.get("genres")
    res = wl_store.add_whitelist_entries([entry])
    if _needs_enrich:
        try:
            import threading
            _entry_copy = dict(entry)
            _url_copy = url
            _source_copy = source
            _title_copy = title
            def _bg_enrich():
                try:
                    enriched = enrich_whitelist_entry(dict(_entry_copy), _url_copy, _source_copy, _title_copy)
                    # Only update if enrich actually added something
                    if enriched.get("cover") != _entry_copy.get("cover") or enriched.get("description") != _entry_copy.get("description") or enriched.get("genres") != _entry_copy.get("genres"):
                        # Re-upsert with enriched fields (preserve title_key/source)
                        wl_store.add_whitelist_entries([enriched])
                except Exception:
                    pass
            threading.Thread(target=_bg_enrich, daemon=True).start()
        except Exception:
            pass
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

    # Apply source filter if provided — bulk (1 query, bukan N)
    if _src and matched_ids:
        try:
            r = sb.table("whitelist").select("id, source").in_("id", list(matched_ids)).eq("source", _src).execute()
            matched_ids = {x["id"] for x in (r.data or [])}
        except Exception as _e:
            logger.warn("delete_whitelist: source filter failed", err=str(_e)[:120])
            matched_ids = set()

    # Atomic: whitelist + recent_chapters dalam 1 tx (1 conn, 1 commit)
    deleted = 0
    rc_deleted = 0
    conn = None
    cur = None
    try:
        from app.db_adapter import get_conn as _gc, put_conn as _pc
        conn = _gc()
        cur = conn.cursor()
        if matched_ids:
            # whitelist delete via raw SQL dalam tx yang sama (bukan builder commit terpisah)
            ph = ", ".join(["%s"] * len(matched_ids))
            cur.execute(f"DELETE FROM whitelist WHERE id IN ({ph}) RETURNING id", list(matched_ids))
            deleted = len(cur.fetchall() or [])
        # recent_chapters delete dalam tx yang sama
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
    except Exception as _e:
        logger.warn("delete_whitelist: atomic delete failed", err=str(_e)[:160])
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
    finally:
        if cur is not None:
            try:
                cur.close()
            except Exception:
                pass
        if conn:
            try:
                put_conn(conn)
            except Exception:
                pass

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


def enrich_whitelist_entry(entry: dict, url: str, source: str, title: str) -> dict:
    """Enrich a whitelist entry with description/cover/genres from source API.

    Called by post_whitelist when fields are missing. Fetches directly from
    source API so the whitelist response immediately has metadata.
    """
    if not entry.get("description") or not entry.get("cover") or not entry.get("genres"):
        try:
            _url_for_meta = entry.get("series_url") or url or ""
            if source == "shinigami" and _url_for_meta:
                _m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", _url_for_meta)
                if _m:
                    from app.scrapers import shinigami as _sh2
                    meta = _sh2.get_shinigami_series_meta(_m.group(1))
                    if meta:
                        for k in ("cover", "rating", "genres", "description", "origin"):
                            if not entry.get(k) and meta.get(k):
                                entry[k] = meta[k]
                        if not entry.get("series_url") and meta.get("series_url"):
                            entry["series_url"] = meta["series_url"]
            elif source == "ikiru" and _url_for_meta:
                _slug = _url_for_meta.rstrip("/").split("/")[-1]
                if "/manga/" in _url_for_meta:
                    _slug = _url_for_meta.split("/manga/")[-1].split("/")[0]
                if _slug and "chapter-" not in _slug:
                    from app.scrapers import ikiru as _ik2
                    meta = _ik2.get_ikiru_series_meta(_slug)
                    if meta:
                        for k in ("cover", "rating", "genres", "description", "series_url"):
                            if not entry.get(k) and meta.get(k):
                                entry[k] = meta[k]
                        if not entry.get("origin") and meta.get("type"):
                            _o = normalize_origin(meta.get("type"))
                            if _o:
                                entry["origin"] = _o
            elif source == "voratoon" and _url_for_meta:
                _m = re.search(r"/series/([^/?#]+)", _url_for_meta)
                if _m:
                    from app.scrapers import voratoon as _vt2
                    try:
                        d = _vt2.fetch_series_detail(_m.group(1))
                        if d:
                            data = d.get("data", {})
                            meta = {
                                "cover": scrub_cover(data.get("coverImage")),
                                
                                "rating": float(data.get("rating")) if data.get("rating") not in (None, "", 0) else 0.0,
                                "genres": [g.get("data", {}).get("name", "") for g in data.get("genres", []) if g.get("data", {}).get("name")],
                                "description": data.get("synopsis", ""),
                                "series_url": f"{settings.VORATOON_API_URL.rstrip(chr(47))}/series/{_m.group(1)}",
                                "type": (data.get("format") or "").lower() or None,
                                "origin": "CN" if (data.get("format") or "").lower() == "manhua" else "KR",
                            }
                            for k in ("cover", "rating", "genres", "description", "series_url", "type", "origin"):
                                if not entry.get(k) and meta.get(k):
                                    entry[k] = meta[k]
                    except Exception:
                        pass
            # Fallback: search by title if still missing
            if (not entry.get("description") or not entry.get("cover")) and title:
                try:
                    if source == "shinigami":
                        from app.scrapers.shinigami import search_shinigami_api, get_shinigami_series_meta as _gsm
                        hits = search_shinigami_api(title, per_page=3)
                        for h in hits:
                            mid = h.get("manga_id")
                            if mid:
                                m2 = _gsm(mid)
                                if m2 and m2.get("description"):
                                    for k in ("cover", "rating", "genres", "description", "origin", "series_url"):
                                        if not entry.get(k) and m2.get(k):
                                            entry[k] = m2[k]
                                    break
                    elif source == "ikiru":
                        from app.scrapers.ikiru import search_ikiru_api, get_ikiru_series_meta as _gim
                        hits = search_ikiru_api(title, per_page=3)
                        for h in hits:
                            slug2 = (h.get("permalink") or "").rstrip("/").split("/")[-1] if h.get("permalink") else h.get("slug")
                            if slug2:
                                m2 = _gim(slug2)
                                if m2 and m2.get("description"):
                                    for k in ("cover", "rating", "genres", "description", "series_url"):
                                        if not entry.get(k) and m2.get(k):
                                            entry[k] = m2[k]
                                    break
                except Exception:
                    pass
        except Exception:
            pass
    return entry


def build_whitelist_mapped_row(r: dict, rc_map: dict, meta_desc: dict, meta_cover: dict, last_notified: dict) -> dict:
    """Build a single whitelist response row with metadata joins.

    Shared by get_whitelist() to map storage rows to API response format.
    rc_map is keyed by (title_key, source) so each whitelist row (voratoon
    vs shinigami for the same title) gets its OWN recent_chapters
    series_url instead of an arbitrary cross-source one.
    """
    tk = r.get("title_key", "")
    s = r.get("source", "")
    rc = rc_map.get((tk, s)) or rc_map.get(tk, {})
    _wl_raw = r.get("series_url") or ""
    _wl_series = _wl_raw if str(_wl_raw).startswith(("http://", "https://")) else (rc.get("series_url") or "")
    # cover must be a real http(s) URL; scrapers/FE sometimes store 'x' or
    # other non-URL placeholders — fall through to recent_chapters cover.
    _wl_cover = r.get("cover")
    _cover = _wl_cover if str(_wl_cover or "").startswith(("http://", "https://")) else (rc.get("cover") or "")
    if _cover:
        _cover = scrub_cover(_cover)
    desc = r.get("description") or meta_desc.get(tk) or meta_desc.get(tk.replace(" ", "-")) or None
    if not desc and _wl_series:
        seg = _wl_series.rstrip("/").split("/")[-1]
        desc = meta_desc.get(seg) or None
    _meta_cov = meta_cover.get(tk) or meta_cover.get(" ".join(tk.split("-"))) or ""
    if _meta_cov:
        _meta_cov = scrub_cover(_meta_cov)
    return {
        "id": str(r.get("id") or f"{tk}:{s}" if s else tk),
        "title": html.unescape(r.get("title") or ""),
        "titleKey": tk,
        "canonicalTitleKey": normalize_title_key(tk),
        "cover": _cover or _meta_cov or "",
        "source": s,
        "sources": [s] if s else [],
        "sourceUrls": {s: (_wl_series or "")} if s else {},
        
        "rating": r.get("rating") or None,
        "type": r.get("type") or None,
        "origin": r.get("origin") or "",
        "genres": r.get("genres") or [],
        "description": desc,
        "seriesUrl": _wl_series,
        "url": _wl_series,
        "lastNotified": last_notified.get(tk) or None,
        "lastChapter": rc.get("updated_time") or None,
        "time": rc.get("updated_time") or None,
        "latestChapter": r.get("latest_chapter"),
        "latestSentChapter": r.get("latest_sent_chapter"),
        "createdAt": r.get("created_at") or None,
    }


def _fetch_whitelist_enrichment(sb, rows: list[dict], all_tks: list[str]):
    """Fetch rc/meta/dh maps for get_whitelist — isolated for testability."""
    rc_map: dict = {}
    meta_desc: dict[str, str] = {}
    meta_cover: dict[str, str] = {}
    last_notified: dict[str, str] = {}

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
    try:
        _dh_data = (dh_rows.data if (dh_rows and getattr(dh_rows, "data", None)) else [])
        for d in _dh_data:
            tk = d.get("title_key", "")
            ts = d.get("sent_at") or ""
            if tk and (tk not in last_notified or ts > last_notified[tk]):
                last_notified[tk] = ts
    except Exception:
        pass
    return rc_map, meta_desc, meta_cover, last_notified

def auto_cleanup_stale_whitelist(days: int = 30, dry_run: bool = False) -> dict:
    """Remove whitelist entries that were added >`days` ago AND have NEVER
    been notified (no dispatch_history row at all)."""
    return wl_store.auto_cleanup_stale_whitelist(days=days, dry_run=dry_run)


def _canonical_of(tk: str) -> str:
    from app.storage.canonical import canonical_of as _co
    return _co(tk)

# ponytail: inlined from whitelist_dedup.py (57L) — single caller, no reuse, delete file when merged
def dedup_whitelist(mapped: list[dict], canonical_of) -> list[dict]:
    if not mapped:
        return []
    groups: dict[str, list[dict]] = {}
    for m in mapped:
        nk = canonical_of(m["titleKey"]) or m["titleKey"]
        groups.setdefault(nk, []).append(m)
    deduped: list[dict] = []
    for _items in groups.values():
        if len(_items) == 1:
            deduped.append(_items[0])
            continue
        _primary = _items[0]
        _sources: list[dict] = []
        _seen_src: set[str] = set()
        for _it in _items:
            for _s in _it.get("sources", []):
                if _s not in _seen_src:
                    _seen_src.add(_s)
                    _sources.append({"source": _s, "url": _it.get("series_url") or ""})
        _merged = dict(_primary)
        _merged["sources"] = [s["source"] for s in _sources]
        _merged["source"] = _sources[0]["source"] if _sources else (_primary.get("source") or "")
        _merged["source_detail"] = _sources
        for _fld in ("cover", "origin", "rating", "description", "type"):
            for _it in _items:
                if _it.get(_fld):
                    _merged[_fld] = _it[_fld]
                    break
        _genres: list[str] = []
        for _it in _items:
            for _g in (_it.get("genres") or []):
                if _g not in _genres:
                    _genres.append(_g)
        _merged["genres"] = _genres
        _merged["created_at"] = max([_it.get("created_at") or "" for _it in _items]) or _primary.get("created_at")
        for _fld in ("latest_chapter", "latest_sent_chapter"):
            _vals = [_it.get(_fld) for _it in _items if _it.get(_fld) is not None]
            _merged[_fld] = max(_vals) if _vals else None
        deduped.append(_merged)
    return deduped
