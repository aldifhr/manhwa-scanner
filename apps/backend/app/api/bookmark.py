"""Bookmark API — save reading position per chapter."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth
from app.services.bookmark import save_bookmark, get_bookmarks, get_bookmark, delete_bookmark

logger = get_logger("api:bookmark")
router = APIRouter()

# simple in-memory rate limit: 10 POST / min per session_hash
_bookmark_rl: dict[str, list[float]] = {}
import time as _rl_time


@router.get("/bookmarks")
async def bookmarks_list(request: Request):
    """Get bookmarks for current session with pagination."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.api.continue_reading import _get_session_hash
        from app.utils.request_auth import int_safe
        session_hash = _get_session_hash(request)
        has_page = "page" in request.query_params or "page_size" in request.query_params
        if has_page:
            page = int_safe(request.query_params.get("page", "1"), 1)
            page_size = int_safe(request.query_params.get("page_size", "50"), 50, max_val=100)
            offset = (page - 1) * page_size
            bookmarks = get_bookmarks(session_hash, limit=page_size, offset=offset)
            try:
                from app.db import q as _q
                total_rows = _q("SELECT COUNT(*) as cnt FROM chapter_bookmarks WHERE session_hash=%s", [session_hash])
                total = total_rows[0]["cnt"] if total_rows else len(bookmarks)
            except Exception:
                total = len(bookmarks)
            return JSONResponse(content={"success": True, "data": {"results": bookmarks, "total": total, "page": page, "page_size": page_size, "hasMore": len(bookmarks) == page_size}})
        else:
            # backward compat: old FE expects array
            bookmarks = get_bookmarks(session_hash, limit=100, offset=0)
            return JSONResponse(content={"success": True, "data": bookmarks})
    except Exception as e:
        logger.warn("bookmarks list failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.post("/bookmarks")
async def bookmark_create(request: Request):
    """Create or update a bookmark."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    # rate limit 10/min per session
    try:
        from app.api.continue_reading import _get_session_hash as _rl_hash
        _rl_sess = _rl_hash(request)
        _now = _rl_time.time()
        _lst = _bookmark_rl.get(_rl_sess, [])
        _lst = [t for t in _lst if _now - t < 60]
        if len(_lst) >= 10:
            return JSONResponse(content={"success": False, "error": "rate_limited"}, status_code=429)
        _lst.append(_now)
        _bookmark_rl[_rl_sess] = _lst
        # cleanup old keys occasionally
        if len(_bookmark_rl) > 1000:
            for k in list(_bookmark_rl.keys())[:500]:
                if not _bookmark_rl[k] or _now - _bookmark_rl[k][-1] > 300:
                    _bookmark_rl.pop(k, None)
    except Exception:
        pass
    
    try:
        body = await request.json()
        title_key = body.get("title_key", "")
        chapter_number = float(body.get("chapter_number", 0))
        chapter_url = body.get("chapter_url", "")
        source = body.get("source", "")
        position_pct = float(body.get("position_pct", 0.0))
        title = body.get("title", "")
        cover = body.get("cover", "")
        
        if not title_key or not chapter_number:
            return JSONResponse(content={"success": False, "error": "title_key and chapter_number required"}, status_code=400)
        
        from app.api.continue_reading import _get_session_hash
        session_hash = _get_session_hash(request)
        
        result = save_bookmark(title_key, chapter_number, chapter_url, session_hash, source, position_pct, title, cover)
        return JSONResponse(content={"success": True, "data": result})
    except Exception as e:
        logger.warn("bookmark create failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.delete("/bookmarks/{title_key}/{chapter_number}")
async def bookmark_delete(request: Request, title_key: str, chapter_number: float):
    """Delete a bookmark."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.api.continue_reading import _get_session_hash
        session_hash = _get_session_hash(request)
        result = delete_bookmark(title_key, chapter_number, session_hash)
        return JSONResponse(content={"success": True, "data": result})
    except Exception as e:
        logger.warn("bookmark delete failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
