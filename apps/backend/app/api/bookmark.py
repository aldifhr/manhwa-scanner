"""Bookmark API — save reading position per chapter."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth
from app.services.bookmark import save_bookmark, get_bookmarks, get_bookmark, delete_bookmark

logger = get_logger("api:bookmark")
router = APIRouter()


@router.get("/api/v1/bookmarks")
async def bookmarks_list(request: Request):
    """Get all bookmarks for current session."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        # Get session hash from request
        from app.api.continue_reading import _get_session_hash
        session_hash = _get_session_hash(request)
        bookmarks = get_bookmarks(session_hash)
        return JSONResponse(content={"success": True, "data": bookmarks})
    except Exception as e:
        logger.warn("bookmarks list failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.post("/api/v1/bookmarks")
async def bookmark_create(request: Request):
    """Create or update a bookmark."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
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


@router.delete("/api/v1/bookmarks/{title_key}/{chapter_number}")
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
