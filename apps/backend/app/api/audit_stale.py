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
            SELECT w.title_key, w.title,
                   COALESCE(GREATEST(rc2.rc_max, dh.dh_max), rc2.rc_max, dh.dh_max) as last_update,
                   EXTRACT(DAY FROM NOW() - COALESCE(GREATEST(rc2.rc_max, dh.dh_max), rc2.rc_max, dh.dh_max))::int as days_idle,
                   COALESCE(rc2.cnt,0)::int as chapter_count
            FROM whitelist w
            LEFT JOIN (SELECT title_key, MAX(updated_time) as rc_max, COUNT(*) as cnt FROM recent_chapters GROUP BY title_key) rc2 ON rc2.title_key = w.title_key
            LEFT JOIN (SELECT title_key, MAX(sent_at) as dh_max FROM dispatch_history GROUP BY title_key) dh ON dh.title_key = w.title_key
            WHERE COALESCE(GREATEST(rc2.rc_max, dh.dh_max), rc2.rc_max, dh.dh_max) IS NULL
               OR COALESCE(GREATEST(rc2.rc_max, dh.dh_max), rc2.rc_max, dh.dh_max) < NOW() - (%s || ' days')::interval
            ORDER BY 3 ASC NULLS FIRST
            LIMIT %s
        """, [str(days), str(limit)])
        return JSONResponse(content={"success": True, "data": {"results": rows, "days": days, "limit": limit}})
    except Exception as e:
        logger.error("audit_stale failed", exc=e)
        return JSONResponse(content=safe_error(e), status_code=500)
