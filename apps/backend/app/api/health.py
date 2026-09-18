"""Health endpoints — extracted from main.py god-file."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import safe_error, require_monitor_auth

logger = get_logger("api:health")
router = APIRouter()


@router.get("/healthz")
async def healthz():
    """Liveness probe: check DB + Redis are reachable."""
    try:
        from app.db import q as _q
        _q("SELECT 1")
    except Exception as e:
        logger.warn("healthz db check failed", err=str(e)[:200])
        return JSONResponse(content={"status": "error", "service": "be-ag-py", "error": "unavailable"}, status_code=503)
    try:
        from app.tasks.queue import _get_redis as _gr
        _gr().ping()
    except Exception as e:
        logger.warn("healthz redis check failed", err=str(e)[:200])
        return JSONResponse(content={"status": "error", "service": "be-ag-py", "error": "unavailable"}, status_code=503)
    return {"status": "ok", "service": "be-ag-py"}


@router.get("/health")
async def api_health(request: Request):
    """Health + source status overview (monitor auth)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.config import settings as _s
        from app.storage import health as _h
        from app.db import get_supabase as _gsb

        hm = _h.load_source_health_map(_s.SOURCE_KEYS)
        sources = []
        for src, row in (hm or {}).items():
            ok_24h = int(row.get("successes_today") or 0) + int(row.get("failures_today") or 0)
            err_rate = round(100.0 * int(row.get("failures_today") or 0) / ok_24h, 1) if ok_24h else 0.0
            sources.append({
                "name": src,
                "status": row.get("status", "healthy"),
                "lastScrape": row.get("last_checked_at") or "",
                "lastSuccess": row.get("last_success_at") or "",
                "errorRate24h": err_rate,
                "consecutiveFailures": row.get("consecutive_failures") or 0,
                "lastError": row.get("last_error"),
                "disabledUntil": row.get("disabled_until"),
            })

        pending = 0
        try:
            from app.storage import recent_chapters as _rc
            rows = _rc._fetch_recent_rows(hours=24, limit=2000, offset=0)
            urls = [r.get("chapter_url") for r in rows if r.get("chapter_url")]
            if urls:
                _dh = _gsb().table("dispatch_history").select("chapter_url").in_("chapter_url", urls).execute()
                sent_urls = {r["chapter_url"] for r in (_dh.data or [])}
                pending = sum(1 for u in urls if u not in sent_urls)
        except Exception:
            pending = -1

        return JSONResponse(content={
            "success": True,
            "data": {
                "sources": sources,
                "pending": pending,
                "service": "be-ag-py",
                "status": "healthy",
            },
        })
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.get("/health/detailed")
async def health_detailed(request: Request):
    """Detailed health — circuit breakers, pool stats, voratoon cover expiry."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.services.resilience import cb_discord, cb_db, cb_ikiru, cb_shinigami, cb_voratoon
    from app.db import get_pool_stats
    from app.storage import health as health_store
    from app.config import settings
    try:
        pool = get_pool_stats()
    except Exception:
        pool = {"active": -1, "idle": -1}
    hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
    sources = []
    for src, row in (hm or {}).items():
        ok_24h = int(row.get("successes_today") or 0) + int(row.get("failures_today") or 0)
        err_rate = round(100.0 * int(row.get("failures_today") or 0) / ok_24h, 1) if ok_24h else 0.0
        sources.append({
            "name": src,
            "status": row.get("status", "healthy"),
            "lastScrape": row.get("last_checked_at") or "",
            "lastSuccess": row.get("last_success_at") or "",
            "errorRate24h": err_rate,
            "consecutiveFailures": row.get("consecutive_failures") or 0,
            "lastError": row.get("last_error"),
            "disabledUntil": row.get("disabled_until"),
        })
    overall = "healthy"
    down_count = sum(1 for s in sources if s["status"] == "down")
    degraded_count = sum(1 for s in sources if s["status"] == "degraded")
    if down_count > 0:
        overall = "down"
    elif degraded_count > 0:
        overall = "degraded"
    return {
        "success": True,
        "data": {
            "sources": sources,
            "overall": overall,
            "pool": pool,
            "circuit_breakers": {
                "discord": cb_discord.state.value,
                "db": cb_db.state.value,
                "ikiru": cb_ikiru.state.value,
                "shinigami": cb_shinigami.state.value,
                "voratoon": cb_voratoon.state.value,
            },
        },
    }
