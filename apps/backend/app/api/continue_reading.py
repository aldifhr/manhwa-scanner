"""Continue reading API — per-user session-based continue reading."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from typing import Optional
from datetime import datetime, timezone

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:continue_reading")
router = APIRouter()


class ContinueReadingEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title_key: str
    chapter: str
    chapter_url: str
    series_url: str
    source: str
    cover: Optional[str] = None
    title: Optional[str] = None
    updated_at: Optional[str] = None


@router.get("/continue-reading")
async def get_continue_reading(request: Request):
    """Get continue-reading entries for current user."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.db import get_supabase
        from app.utils.request_auth import get_session_hash
        
        session_hash = get_session_hash(request)
        if not session_hash:
            return JSONResponse(content={"success": True, "data": {"entries": {}}})
        
        sb = get_supabase()
        res = (
            sb.table("continue_reading")
            .select("entries")
            .eq("session_hash", session_hash)
            .maybe_single()
            .execute()
        )
        
        entries: dict = {}
        if res.data and isinstance(res.data.get("entries"), dict):
            entries = res.data["entries"]
        
        return JSONResponse(content={
            "success": True,
            "data": {"entries": entries}
        })
    except Exception as e:
        logger.warn("get_continue_reading failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.post("/continue-reading")
async def update_continue_reading(request: Request, entry: ContinueReadingEntry):
    """Update continue-reading entry for current user."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.db import get_supabase
        from app.utils.request_auth import get_session_hash
        
        session_hash = get_session_hash(request)
        if not session_hash:
            return JSONResponse(content={"success": False, "error": "no session"}, status_code=400)
        
        sb = get_supabase()
        
        # Get existing entries
        existing = (
            sb.table("continue_reading")
            .select("entries")
            .eq("session_hash", session_hash)
            .maybe_single()
            .execute()
        )
        
        entries: dict = {}
        if existing.data and isinstance(existing.data.get("entries"), dict):
            entries = existing.data["entries"]
        
        # Update entry
        entries[entry.title_key] = {
            "chapter": entry.chapter,
            "chapter_url": entry.chapter_url,
            "series_url": entry.series_url,
            "source": entry.source,
            "cover": entry.cover or "",
            "title": entry.title or entry.title_key,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        
        # Upsert
        sb.table("continue_reading").upsert(
            {
                "session_hash": session_hash,
                "entries": entries,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="session_hash",
        ).execute()
        
        return JSONResponse(content={"success": True})
    except Exception as e:
        logger.warn("update_continue_reading failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/continue-reading/history")
async def get_continue_reading_history(request: Request):
    """Get continue-reading history (sorted by updated_at desc)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.db import get_supabase
        from app.utils.request_auth import get_session_hash
        
        session_hash = get_session_hash(request)
        if not session_hash:
            return JSONResponse(content={"success": True, "data": {"history": []}})
        
        sb = get_supabase()
        res = (
            sb.table("continue_reading")
            .select("entries")
            .eq("session_hash", session_hash)
            .maybe_single()
            .execute()
        )
        
        history = []
        if res.data and res.data.get("entries"):
            entries = res.data["entries"]
            for tk, entry in entries.items():
                history.append({
                    "title_key": tk,
                    **entry,
                })
            # Sort by updated_at desc
            history.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        
        return JSONResponse(content={
            "success": True,
            "data": {"history": history}
        })
    except Exception as e:
        logger.warn("get_continue_reading_history failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.post("/continue-reading/mark-read")
async def mark_read(request: Request):
    """Mark a chapter as read (remove from continue-reading)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON"}, status_code=400)

    title_key = body.get("title_key", "").strip()
    if not title_key:
        return JSONResponse(content={"success": False, "error": "title_key required"}, status_code=400)

    try:
        from app.db import get_supabase
        from app.utils.request_auth import get_session_hash

        session_hash = get_session_hash(request)
        if not session_hash:
            return JSONResponse(content={"success": False, "error": "no session"}, status_code=400)

        sb = get_supabase()
        existing = (
            sb.table("continue_reading")
            .select("entries")
            .eq("session_hash", session_hash)
            .maybe_single()
            .execute()
        )

        entries: dict = {}
        if existing.data and isinstance(existing.data.get("entries"), dict):
            entries = existing.data["entries"]

        if title_key in entries:
            del entries[title_key]
            sb.table("continue_reading").upsert(
                {
                    "session_hash": session_hash,
                    "entries": entries,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
                on_conflict="session_hash",
            ).execute()

        return JSONResponse(content={"success": True})
    except Exception as e:
        logger.warn("mark_read failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/continue-reading/unread-count")
async def unread_count(request: Request):
    """Get count of unread continue-reading entries."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.db import get_supabase
        from app.utils.request_auth import get_session_hash
        
        session_hash = get_session_hash(request)
        if not session_hash:
            return JSONResponse(content={"success": True, "data": {"count": 0}})
        
        sb = get_supabase()
        res = (
            sb.table("continue_reading")
            .select("entries")
            .eq("session_hash", session_hash)
            .maybe_single()
            .execute()
        )
        
        count = 0
        if res.data and res.data.get("entries"):
            count = len(res.data["entries"])
        
        return JSONResponse(content={
            "success": True,
            "data": {"count": count}
        })
    except Exception as e:
        logger.warn("unread_count failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
