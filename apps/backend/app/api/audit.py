"""Audit log API — query audit trail."""
from __future__ import annotations

from fastapi import APIRouter, Request, Query
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth
from app.services.audit import get_audit_log, get_audit_stats, AuditAction

logger = get_logger("api:audit")
router = APIRouter()


@router.get("/audit-log")
async def audit_log_list(
    request: Request,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    action: str | None = None,
    actor: str | None = None,
    since: str | None = None,
):
    """List audit log entries with filters."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        entries = get_audit_log(limit=limit, offset=offset, action=action, actor=actor, since=since)
        return JSONResponse(content={"success": True, "data": entries})
    except Exception as e:
        logger.warn("audit_log list failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/api/v1/audit-log/stats")
async def audit_log_stats(request: Request, days: int = Query(7, ge=1, le=90)):
    """Get audit statistics."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        stats = get_audit_stats(days=days)
        return JSONResponse(content={"success": True, "data": stats})
    except Exception as e:
        logger.warn("audit_log stats failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
