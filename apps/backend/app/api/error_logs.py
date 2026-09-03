"""Error logs API — persistent journal for backend errors."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth, require_role_auth, int_safe, safe_error

logger = get_logger("api:error_logs")
router = APIRouter()


@router.get("/logs/errors")
async def list_errors(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.storage.error_logs import query_errors

        page = int_safe(request.query_params.get("page", "1"), 1)
        page_size = int_safe(request.query_params.get("page_size", "50"), 50, max_val=200)
        level = (request.query_params.get("level") or "").strip() or None
        source = (request.query_params.get("source") or "").strip() or None
        q = (request.query_params.get("q") or request.query_params.get("search") or "").strip() or None
        since_hours = request.query_params.get("since_hours")
        since = None
        if since_hours:
            try:
                since = int(since_hours)
            except Exception:
                since = None
        data = query_errors(page=page, page_size=page_size, level=level, source=source, q=q, since_hours=since)
        return JSONResponse(content={"success": True, "data": data})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.delete("/logs/errors")
async def clear_errors(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.storage.error_logs import delete_older_than

        days_raw = request.query_params.get("days", "30")
        try:
            days = int(days_raw)
        except Exception:
            days = 30
        days = max(1, min(365, days))
        deleted = delete_older_than(days=days)
        return JSONResponse(content={"success": True, "data": {"deleted": deleted, "days": days}})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/logs/errors/test")
async def test_error(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        logger.warn("test error log", path="/logs/errors/test", test=True)
        logger.error("test error log", test=True)
        return JSONResponse(content={"success": True, "data": {"logged": True}})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)
