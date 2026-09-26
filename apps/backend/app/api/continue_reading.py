"""Continue reading — per-device sync via session_hash."""
import hashlib
import time as _time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger

logger = get_logger("api:continue-reading")
router = APIRouter()

def _session_hash(request: Request) -> str | None:
    # Use ikiru_dashboard_session JWT as device session identifier (same as FE continueReading)
    cookie = request.cookies.get("ikiru_dashboard_session") or ""
    if not cookie:
        # fallback to Authorization Bearer token if present
        auth = request.headers.get("authorization") or request.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            cookie = auth[7:].strip()
    if not cookie or len(cookie) < 5:
        return None
    return hashlib.sha256(cookie.encode()).hexdigest()[:16]


@router.get("/continue-reading")
async def get_continue_reading(request: Request):
    h = _session_hash(request)
    if not h:
        return JSONResponse(content={"success": True, "data": {"entries": {}}})
    try:
        from app.db import get_supabase
        sb = get_supabase()
        res = sb.table("continue_reading").select("entries, updated_at").eq("session_hash", h).limit(1).execute()
        if res.data:
            row = res.data[0]
            entries = row.get("entries") or {}
            # entries is jsonb, may be string
            if isinstance(entries, str):
                import json as _j
                try:
                    entries = _j.loads(entries)
                except Exception:
                    entries = {}
            return JSONResponse(content={"success": True, "data": {"entries": entries, "updated_at": row.get("updated_at")}})
        return JSONResponse(content={"success": True, "data": {"entries": {}}})
    except Exception as e:
        logger.warn("continue-reading get failed", err=str(e)[:120])
        return JSONResponse(content={"success": True, "data": {"entries": {}}})


@router.put("/continue-reading")
async def put_continue_reading(request: Request):
    h = _session_hash(request)
    if not h:
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
        entries = body.get("entries") or body.get("data") or {}
        if not isinstance(entries, dict):
            return JSONResponse(content={"success": False, "error": "invalid entries"}, status_code=400)
        # cap 20 entries server-side too
        if len(entries) > 20:
            # keep most recent 20 by updatedAt
            sorted_entries = sorted(entries.items(), key=lambda kv: kv[1].get("updatedAt", "") if isinstance(kv[1], dict) else "", reverse=True)[:20]
            entries = dict(sorted_entries)
        from app.db import get_supabase
        sb = get_supabase()
        # upsert
        sb.table("continue_reading").upsert({"session_hash": h, "entries": entries, "updated_at": _time.time()}, on_conflict="session_hash").execute()
        return JSONResponse(content={"success": True})
    except Exception as e:
        logger.warn("continue-reading put failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.delete("/continue-reading")
async def delete_continue_reading(request: Request):
    h = _session_hash(request)
    if not h:
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
        title_key = body.get("titleKey") or body.get("title_key") if isinstance(body, dict) else None
        from app.db import get_supabase
        sb = get_supabase()
        if title_key:
            res = sb.table("continue_reading").select("entries").eq("session_hash", h).limit(1).execute()
            if res.data:
                entries = res.data[0].get("entries") or {}
                if isinstance(entries, str):
                    import json as _j
                    try:
                        entries = _j.loads(entries)
                    except Exception:
                        entries = {}
                if title_key in entries:
                    del entries[title_key]
                    sb.table("continue_reading").upsert({"session_hash": h, "entries": entries, "updated_at": _time.time()}, on_conflict="session_hash").execute()
        else:
            sb.table("continue_reading").delete().eq("session_hash", h).execute()
        return JSONResponse(content={"success": True})
    except Exception as e:
        logger.warn("continue-reading delete failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.delete("/continue-reading")
async def delete_continue_reading(request: Request):
    """Delete continue-reading entries (single or all) for current user."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.db import get_supabase
        from app.utils.request_auth import get_session_hash
        session_hash = get_session_hash(request)
        if not session_hash:
            return JSONResponse(content={"success": False, "error": "no session"}, status_code=400)
        
        try:
            body = await request.json()
        except Exception:
            body = {}
        
        title_key = body.get("title_key", "").strip()
        
        sb = get_supabase()
        
        if title_key:
            # Single: fetch, remove key, upsert back
            res = (
                sb.table("continue_reading").select("entries")
                .eq("session_hash", session_hash).maybe_single().execute()
            )
            entries = {}
            if res.data and isinstance(res.data.get("entries"), dict):
                entries = res.data["entries"]
            entries.pop(title_key, None)
            sb.table("continue_reading").upsert(
                {"session_hash": session_hash, "entries": entries, "updated_at": datetime.now(timezone.utc).isoformat()},
                on_conflict="session_hash"
            ).execute()
        else:
            # All: delete row
            sb.table("continue_reading").delete().eq("session_hash", session_hash).execute()
        
        return JSONResponse(content={"success": True})
    except Exception as e:
        logger.warn("delete_continue_reading failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.post("/continue-reading/bulk")
async def bulk_update_continue_reading(request: Request):
    """Bulk update continue-reading entries (full map) for current user."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON"}, status_code=400)
    entries = body.get("entries", {})
    if not isinstance(entries, dict):
        return JSONResponse(content={"success": False, "error": "entries must be object"}, status_code=400)
    try:
        from app.db import get_supabase
        from app.utils.request_auth import get_session_hash
        session_hash = get_session_hash(request)
        if not session_hash:
            return JSONResponse(content={"success": False, "error": "no session"}, status_code=400)
        get_supabase().table("continue_reading").upsert(
            {"session_hash": session_hash, "entries": entries, "updated_at": datetime.now(timezone.utc).isoformat()},
            on_conflict="session_hash",
        ).execute()
        return JSONResponse(content={"success": True})
    except Exception as e:
        logger.warn("bulk_update_continue_reading failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
