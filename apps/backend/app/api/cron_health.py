"""Cron health dashboard endpoint — aggregates scheduler, source, dispatch, and queue status."""
from __future__ import annotations

import time as _time
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import safe_error, require_monitor_auth

logger = get_logger("api:cron-health")
router = APIRouter()


@router.get("/cron/health")
async def cron_health(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    now = datetime.now(timezone.utc)

    # ── Source health ──
    sources = []
    try:
        from app.storage import health as health_store
        from app.config import settings
        hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
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
                "responseTimeMs": row.get("response_time_ms", 0),
                "disabledUntil": row.get("disabled_until"),
            })
    except Exception as e:
        logger.warn("cron-health: source health failed", err=str(e)[:120])

    # ── Dispatch stats ──
    dispatch_stats = {"sent_24h": 0, "failed_24h": 0, "pending": 0, "total": 0}
    try:
        from app.db import get_supabase
        sb = get_supabase()
        sent_24h = sb.table("dispatch_history").select("id").gte("sent_at", (now - timedelta(hours=24)).isoformat()).execute()
        dispatch_stats["sent_24h"] = len(sent_24h.data or [])
        total = sb.table("dispatch_history").select("id").execute()
        dispatch_stats["total"] = len(total.data or [])
    except Exception as e:
        logger.warn("cron-health: dispatch stats failed", err=str(e)[:120])

    # ── Failed dispatches ──
    failed = []
    try:
        from app.db import get_supabase
        sb = get_supabase()
        failed_rows = sb.table("failed_dispatches").select("*").order("created_at", desc=True).limit(10).execute()
        for r in (failed_rows.data or []):
            failed.append({
                "id": r.get("id"),
                "title_key": r.get("title_key"),
                "source": r.get("source"),
                "chapter": r.get("chapter_title"),
                "error": r.get("error_message", "")[:100],
                "createdAt": r.get("created_at"),
            })
    except Exception:
        pass

    # ── Cron queue depth ──
    queue_depth = 0
    queue_breakdown = {}
    try:
        from app.tasks.queue import _get_redis, QUEUE_KEY, CRON_QUEUE_KEY, QUEUE_PROCESSING_KEY, CRON_PROCESSING_KEY
        redis = _get_redis()
        queue_depth = sum(redis.llen(k) for k in (QUEUE_KEY, CRON_QUEUE_KEY, QUEUE_PROCESSING_KEY, CRON_PROCESSING_KEY))
        queue_breakdown = {"main": redis.llen(QUEUE_KEY), "cron": redis.llen(CRON_QUEUE_KEY), "processing": redis.llen(QUEUE_PROCESSING_KEY) + redis.llen(CRON_PROCESSING_KEY)}
    except Exception:
        pass

    # ── Scheduler status ──
    scheduler = {"alive": False, "last_run": None, "next_run": None}
    try:
        from app.tasks import get_cron_status
        ss = get_cron_status()
        scheduler["alive"] = ss.get("scheduler_alive", False)
        scheduler["last_run"] = ss.get("last_run")
        scheduler["next_run"] = ss.get("next_run")
    except Exception:
        pass

    # ── Circuit breakers ──
    circuits = {}
    try:
        from app.services.resilience import cb_discord, cb_db, cb_ikiru, cb_shinigami, cb_voratoon
        for name, cb in [("discord", cb_discord), ("db", cb_db), ("ikiru", cb_ikiru), ("shinigami", cb_shinigami), ("voratoon", cb_voratoon)]:
            circuits[name] = cb.state.value
    except Exception:
        pass

    # ── Telegram status ──
    telegram = {"configured": False, "lastError": None}
    try:
        from app.config import settings
        telegram["configured"] = bool(settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_CHAT_ID)
    except Exception:
        pass

    return {
        "success": True,
        "data": {
            "sources": sources,
            "dispatch": dispatch_stats,
            "failed": failed,
            "queue": {"depth": queue_depth, "breakdown": queue_breakdown},
            "scheduler": scheduler,
            "circuits": circuits,
            "telegram": telegram,
            "timestamp": now.isoformat(),
        },
    }
