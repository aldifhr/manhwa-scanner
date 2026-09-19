"""Logs errors API — GET/DELETE /api/v1/logs/errors."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth, int_safe, safe_error

logger = get_logger("api:logs")
router = APIRouter()


@router.get("/logs/errors")
async def list_errors(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        page = int_safe(request.query_params.get("page", "1"), 1)
        page_size = int_safe(request.query_params.get("page_size", "50"), 50, max_val=200)
        level = request.query_params.get("level")
        source = request.query_params.get("source")
        q = request.query_params.get("q")
        from app.storage.error_logs import query_errors
        data = query_errors(page=page, page_size=page_size, level=level, source=source, q=q)
        return JSONResponse(content={"success": True, "data": data})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.delete("/logs/errors")
async def clear_errors(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.storage.error_logs import clear_all
        deleted = clear_all()
        return JSONResponse(content={"success": True, "data": {"deleted": deleted}})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)
