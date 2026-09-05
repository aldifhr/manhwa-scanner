"""Excluded-titles routes (RSS "Exclude" feature).

GET    /api/excluded-titles        -> list all excluded titles
POST   /api/excluded-titles        -> {title_key, title?, source?} add
DELETE /api/excluded-titles        -> {title_key, source?} remove
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.storage import excluded_titles as excl_store
from app.utils.request_auth import require_monitor_auth, require_role_auth, safe_error, int_safe

logger = get_logger("api:excluded-titles")
router = APIRouter()

# In-memory cache for the GET (15s TTL) so dashboard polls don't re-hit Supabase.
_LIST_CACHE: list = [0.0, None]
_LIST_TTL = 15.0


@router.get("/excluded-titles")
async def get_excluded(request: Request):
    """Return ALL excluded titles. Public GET for anon/member dashboard."""
    # ponytail: public GET, no auth
    _now = time.monotonic()
    if _LIST_CACHE[0] is not None and (_now - _LIST_CACHE[0]) < _LIST_TTL:
        return JSONResponse(content=_LIST_CACHE[1])
    try:
        # Base query: ALL excluded titles, no JOIN filter
        rows = excl_store.list_excluded_titles()
        total = len(rows)

        # Pagination
        page = int_safe(request.query_params.get("page"), default=1)
        page_size = min(int_safe(request.query_params.get("page_size"), default=50, max_val=200), 200)
        start = (page - 1) * page_size
        end = start + page_size
        rows = rows[start:end]

        # Optional enrichment: cover/series_url from whitelist/recent_chapters/metadata
        # LEFT JOIN semantics: null if no match, but NEVER filter out the row
        tks = [r.get("title_key") for r in rows if r.get("title_key")]
        cover_map: dict[str, str] = {}
        series_url_map: dict[str, str] = {}
        if tks:
            try:
                from app.db import get_supabase as _gsb
                sb = _gsb()
                # LEFT JOIN whitelist
                wl = sb.table("whitelist").select("title_key, cover, series_url").in_("title_key", tks).execute()
                for w in (wl.data or []):
                    tk = w.get("title_key") or ""
                    if not tk:
                        continue
                    c = w.get("cover")
                    if c and tk not in cover_map:
                        cover_map[tk] = c
                    su = w.get("series_url")
                    if su and tk not in series_url_map:
                        series_url_map[tk] = su
            except Exception:
                pass
            # LEFT JOIN recent_chapters fallback
            if not cover_map:
                try:
                    from app.db import get_supabase as _gsb2
                    sb2 = _gsb2()
                    rc = sb2.table("recent_chapters").select("title_key, cover, series_url").in_("title_key", tks).execute()
                    for r in (rc.data or []):
                        tk = r.get("title_key") or ""
                        if not tk:
                            continue
                        c = r.get("cover")
                        if c and tk not in cover_map:
                            cover_map[tk] = c
                        su = r.get("series_url")
                        if su and tk not in series_url_map:
                            series_url_map[tk] = su
                except Exception:
                    pass
            # LEFT JOIN whitelist fallback for cover/series_url
            if not cover_map:
                try:
                    from app.db import get_supabase as _gsb3
                    sb3 = _gsb3()
                    mm = sb3.table("whitelist").select("title_key, cover, series_url").in_("title_key", tks).execute()
                    for m in (mm.data or []):
                        tk = m.get("title_key") or ""
                        if not tk:
                            continue
                        c = m.get("cover")
                        if c and tk not in cover_map:
                            cover_map[tk] = c
                        su = m.get("series_url")
                        if su and tk not in series_url_map:
                            series_url_map[tk] = su
                except Exception:
                    pass

        results = []
        for r in rows:
            tk = (r.get("title_key") or "").strip()
            title = r.get("title")
            row_cover = r.get("cover")
            row_series_url = r.get("series_url")
            series_url = row_series_url or series_url_map.get(tk)

            # BUG FIX: Never skip rows — excluded_titles is the source of truth
            # Old code had: if not tk and not title and not series_url: continue
            # This incorrectly filtered rows where title was null
            if not tk:
                # Only skip if title_key is completely empty (shouldn't happen)
                continue

            # Fallback: derive title from series_url slug if empty
            if not title and series_url:
                slug = series_url.rstrip("/").split("/")[-1]
                if slug:
                    title = slug.replace("-", " ").replace("_", " ").strip().title()

            item = {
                "id": r.get("id"),
                "titleKey": tk,
                "title": title,
                "source": r.get("source"),
                "createdAt": r.get("created_at"),
                "cover": row_cover or cover_map.get(tk) or None,
                "seriesUrl": series_url,
            }
            results.append(item)

        payload = {"success": True, "data": {"results": results, "total": total, "page": page, "page_size": page_size}}
        _LIST_CACHE[0] = _now
        _LIST_CACHE[1] = payload
        return JSONResponse(content=payload)
    except Exception as e:
        logger.error("get_excluded failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/excluded-titles")
async def post_excluded(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse(content={"success": False, "error": "body must be a JSON object"}, status_code=400)
        title_key = (body.get("title_key") or "").strip()
        title = body.get("title")
        source = body.get("source") or "all"
        cover = body.get("cover")
        series_url = body.get("series_url")
        if not title_key:
            return JSONResponse(content={"success": False, "error": "title_key required"}, status_code=400)
        res = excl_store.add_excluded_title(
            title_key=title_key, title=title, source=source,
            cover=cover, series_url=series_url
        )
        if res.get("status") == "error":
            return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
        _LIST_CACHE[0] = 0.0  # invalidate GET cache
        # Also invalidate storage excluded_keys cache so RSS respects new exclude immediately
        try:
            excl_store._CACHE_TS = 0.0
            from app.api import rss as _rss_mod
            _rss_mod.invalidate_rss_cache()
        except Exception:
            pass
        # Audit log disabled
        # from app.services.audit import log_action, AuditAction
        # log_action(AuditAction.EXCLUDE_ADD, actor=request.headers.get("x-forwarded-for", "system"), target=title_key, details={"source": source})
        return JSONResponse(content={"success": True, "data": res})
    except Exception as e:
        logger.error("post_excluded failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)


@router.delete("/excluded-titles")
async def delete_excluded(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse(content={"success": False, "error": "body must be a JSON object"}, status_code=400)
        title_key = (body.get("title_key") or "").strip()
        source = body.get("source") or "all"
        if not title_key:
            return JSONResponse(content={"success": False, "error": "title_key required"}, status_code=400)
        res = excl_store.remove_excluded_title(title_key=title_key, source=source)
        if res.get("status") == "error":
            return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
        _LIST_CACHE[0] = 0.0  # invalidate GET cache
        try:
            excl_store._CACHE_TS = 0.0
            from app.api import rss as _rss_mod
            _rss_mod.invalidate_rss_cache()
        except Exception:
            pass
        # Audit log disabled
        # from app.services.audit import log_action, AuditAction
        # log_action(AuditAction.EXCLUDE_REMOVE, actor=request.headers.get("x-forwarded-for", "system"), target=title_key, details={"source": source})
        return JSONResponse(content={"success": True, "data": res})
    except Exception as e:
        logger.error("delete_excluded failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/excluded-titles/bulk")
async def post_excluded_bulk(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse(content={"success": False, "error": "body must be a JSON object"}, status_code=400)
        source = (body.get("source") or "").strip()
        if not source:
            return JSONResponse(content={"success": False, "error": "source required"}, status_code=400)
        if source not in ("ikiru", "shinigami"):
            return JSONResponse(content={"success": False, "error": f"invalid source: {source}"}, status_code=400)
        res = excl_store.exclude_all_by_source(source)
        if res.get("status") == "error":
            return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
        _LIST_CACHE[0] = 0.0
        try:
            excl_store._CACHE_TS = 0.0
            from app.api import rss as _rss_mod
            _rss_mod.invalidate_rss_cache()
        except Exception:
            pass
        return JSONResponse(content={"success": True, "data": res})
    except Exception as e:
        logger.error("post_excluded_bulk failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)
