"""GET /api/v1/audit/stale — whitelist titles with no recent update (dead series)."""
from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth, safe_error

logger = get_logger("api:audit-stale")
router = APIRouter()

@router.get("/audit/stale")
async def audit_stale(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        days = int(request.query_params.get("days", "30"))
        days = max(7, min(days, 365))
        limit = int(request.query_params.get("limit", "20"))
        limit = max(1, min(limit, 100))
        from app.db import q
        rows = q("""
            SELECT w.title_key, w.title, MAX(rc.updated_time) as last_update,
                   EXTRACT(DAY FROM NOW() - MAX(rc.updated_time))::int as days_idle,
                   COUNT(rc.id)::int as chapter_count
            FROM whitelist w
            LEFT JOIN recent_chapters rc ON rc.title_key = w.title_key
            GROUP BY w.title_key, w.title
            HAVING MAX(rc.updated_time) IS NULL OR MAX(rc.updated_time) < NOW() - (%s || ' days')::interval
            ORDER BY last_update ASC NULLS FIRST
            LIMIT %s
        """, [str(days), str(limit)])
        return JSONResponse(content={"success": True, "data": {"results": rows, "days": days, "limit": limit}})
    except Exception as e:
        logger.error("audit_stale failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)
