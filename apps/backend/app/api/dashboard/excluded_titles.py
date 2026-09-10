"""Excluded-titles routes (RSS "Exclude" feature).

GET    /api/excluded-titles        -> list all excluded titles
POST   /api/excluded-titles        -> {title_key, title?, source?} add
DELETE /api/excluded-titles        -> {title_key, source?} remove
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from typing import Optional

from app.logger import get_logger
from app.storage import excluded_titles as excl_store
from app.utils.request_auth import require_monitor_auth, safe_error, int_safe
from app.config import VALID_SOURCES
from app.services.audit import log_action, AuditAction


class ExcludedAddRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title_key: str = Field(..., min_length=1, max_length=200)
    title: Optional[str] = Field(default=None, max_length=200)
    source: Optional[str] = Field(default="all", max_length=50)
    cover: Optional[str] = Field(default=None, max_length=2000)
    series_url: Optional[str] = Field(default=None, max_length=500)
    reason: Optional[str] = Field(default=None, max_length=20)
    is_completed: Optional[bool] = None


class ExcludedDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title_key: str = Field(..., min_length=1, max_length=200)
    source: Optional[str] = Field(default="all", max_length=50)


class ExcludedBulkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(..., min_length=1, max_length=50)

logger = get_logger("api:excluded-titles")
router = APIRouter()

# In-memory cache for the GET (15s TTL) so dashboard polls don't re-hit Supabase.
_LIST_CACHE: list = [0.0, None]
_LIST_TTL = 15.0


@router.get("/excluded-titles")
async def get_excluded(request: Request):
    """Return ALL excluded titles. Admin only."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
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
        type_map: dict[str, str] = {}
        if tks:
            # LEFT JOIN whitelist — cover/series_url/type
            try:
                from app.db import get_supabase as _gsb
                sb = _gsb()
                wl = sb.table("whitelist").select("title_key, cover, series_url, type").in_("title_key", tks).limit(500).execute()
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
                    t = w.get("type")
                    if t and tk not in type_map:
                        type_map[tk] = t
            except Exception:
                pass
            # LEFT JOIN recent_chapters — always fill missing cover/series_url
            try:
                from app.db import get_supabase as _gsb2
                sb2 = _gsb2()
                rc = sb2.table("recent_chapters").select("title_key, cover, series_url").in_("title_key", tks).limit(500).execute()
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
            # LEFT JOIN series_meta — last resort
            try:
                from app.db import get_supabase as _gsb3
                sb3 = _gsb3()
                sm = sb3.table("series_meta").select("title_key, cover").in_("title_key", tks).limit(500).execute()
                for m in (sm.data or []):
                    tk = m.get("title_key") or ""
                    if not tk:
                        continue
                    c = m.get("cover")
                    if c and tk not in cover_map:
                        cover_map[tk] = c
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
                "reason": r.get("reason") or ("completed" if r.get("is_completed") else "excluded"),
                "isCompleted": bool(r.get("is_completed")) or (r.get("reason") == "completed"),
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
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse(content={"success": False, "error": "body must be a JSON object"}, status_code=400)
        try:
            data = ExcludedAddRequest.model_validate(body)
        except Exception as ve:
            from pydantic import ValidationError as _VE
            if isinstance(ve, _VE):
                return JSONResponse(content={"success": False, "error": "validation_error", "details": ve.errors()}, status_code=422)
            raise
        title_key = data.title_key.strip()
        title = data.title
        source = data.source or "all"
        cover = data.cover
        series_url = data.series_url
        reason = (data.reason or "excluded").strip().lower() if data.reason else "excluded"
        is_completed = bool(data.is_completed) or reason == "completed"
        if reason not in ("excluded", "completed"):
            reason = "completed" if is_completed else "excluded"
        res = excl_store.add_excluded_title(
            title_key=title_key, title=title, source=source,
            cover=cover, series_url=series_url, reason=reason, is_completed=is_completed
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
        try:
            log_action(AuditAction.EXCLUDED_ADD, request=request, resource="excluded_titles", resource_id=title_key, metadata={"source": source})
        except Exception:
            pass
        return JSONResponse(content={"success": True, "data": res})
    except Exception as e:
        logger.error("post_excluded failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)


@router.delete("/excluded-titles")
async def delete_excluded(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse(content={"success": False, "error": "body must be a JSON object"}, status_code=400)
        try:
            data = ExcludedDeleteRequest.model_validate(body)
        except Exception as ve:
            from pydantic import ValidationError as _VE
            if isinstance(ve, _VE):
                return JSONResponse(content={"success": False, "error": "validation_error", "details": ve.errors()}, status_code=422)
            raise
        title_key = data.title_key.strip()
        source = data.source or "all"
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
        try:
            log_action(AuditAction.EXCLUDED_DELETE, request=request, resource="excluded_titles", resource_id=title_key, metadata={"source": source})
        except Exception:
            pass
        return JSONResponse(content={"success": True, "data": res})
    except Exception as e:
        logger.error("delete_excluded failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/excluded-titles/bulk")
async def post_excluded_bulk(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse(content={"success": False, "error": "body must be a JSON object"}, status_code=400)
        try:
            data = ExcludedBulkRequest.model_validate(body)
        except Exception as ve:
            from pydantic import ValidationError as _VE
            if isinstance(ve, _VE):
                return JSONResponse(content={"success": False, "error": "validation_error", "details": ve.errors()}, status_code=422)
            raise
        source = data.source.strip()
        if source not in VALID_SOURCES:
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
        try:
            log_action(AuditAction.EXCLUDED_BULK, request=request, resource="excluded_titles", resource_id=source, metadata={"source": source})
        except Exception:
            pass
        return JSONResponse(content={"success": True, "data": res})
    except Exception as e:
        logger.error("post_excluded_bulk failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)
