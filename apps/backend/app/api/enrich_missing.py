"""POST /api/v1/enrich/missing — manual trigger enrich No Desc (miss_only)."""
from __future__ import annotations
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth, safe_error

logger = get_logger("api:enrich-missing")
router = APIRouter()

@router.post("/enrich/missing")
async def enrich_missing(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.tasks.queue import enqueue_cron
        enqueue_cron("enrich-missing")
        return JSONResponse(content={"success": True, "data": {"enqueued": "enrich-missing"}})
    except Exception as e:
        # fallback inline if redis down
        try:
            from app.cron.enrich.resync import enrich_recent_chapters
            stats = enrich_recent_chapters(limit=20, miss_only=True)
            return JSONResponse(content={"success": True, "data": stats})
        except Exception as e2:
            logger.error("enrich_missing failed", exc=e2)
            return JSONResponse(content=safe_error(e), status_code=500)

