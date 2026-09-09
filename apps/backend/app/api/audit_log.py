"""Audit log read API — forensic view for admin."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth, int_safe, safe_error

logger = get_logger("api:audit_log")
router = APIRouter()


@router.get("/audit-log")
async def get_audit_log(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        action = request.query_params.get("action", "")
        resource = request.query_params.get("resource", "")
        limit = int_safe(request.query_params.get("limit", "50"), 50, max_val=200)
        offset = int_safe(request.query_params.get("offset", "0"), 0, max_val=100000)
        from app.db import get_supabase
        sb = get_supabase()
        q = sb.table("audit_log").select("*", count="exact").order("timestamp", desc=True).limit(limit).offset(offset)
        if action:
            q = q.eq("action", action)
        if resource:
            q = q.eq("resource", resource)
        res = q.execute()
        return JSONResponse(content={"success": True, "data": {"results": res.data or [], "total": res.count or 0, "limit": limit, "offset": offset}})
    except Exception as e:
        # Table may not exist yet before migration
        if "does not exist" in str(e):
            return JSONResponse(content={"success": True, "data": {"results": [], "total": 0, "limit": limit, "offset": offset}})
        logger.warn("audit_log fetch failed", err=str(e)[:200])
        return JSONResponse(content=safe_error(e), status_code=500)
