"""Observability / dashboard data API — ponytail: 751L health+incidents+proxy single router intentional, split to per-endpoint routers when file >1000L or cold-start import cost measured. (formerly part of the compat layer).

Endpoints: notifications log, health-status, incidents, history, reader image
proxy, metrics.
"""
import time as _time
import re
import asyncio
import concurrent.futures

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response as FastResponse
from datetime import datetime, timezone, timedelta

from app.config import settings
from app.logger import get_logger
from app.utils.request_auth import int_safe, safe_error, require_monitor_auth
from app.utils.cover_scrub import batch_cover_ref

logger = get_logger("api:observability")
router = APIRouter()


# --- Health-status alias ---
APP_START_TS = _time.time()


def _fmt_uptime(seconds: float) -> str:
    s = int(seconds)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m"
    return f"{m}m {s}s"


@router.get("/health-status")
async def health_status(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase
    from app.storage import health as health_store
    datetime.now(timezone.utc)
    hm = health_store.load_source_health_map(settings.SOURCE_KEYS) or {}
    # ponytail: ensure all SOURCE_KEYS appear even if DB row missing (voratoon was absent)
    for _sk in settings.SOURCE_KEYS:
        if _sk not in hm:
            hm[_sk] = {"source": _sk, "status": "unknown", "consecutive_failures": 0, "last_error": "no data yet", "last_success_at": None, "last_checked_at": None, "response_time_ms": None}
    _api_ping = None
    for r in hm.values():
        rt = r.get("response_time_ms") or 0
        if rt and (_api_ping is None or rt < _api_ping):
            _api_ping = rt
    _sb_ping = None
    _disc_ping = None
    try:
        _sb_client = get_supabase()
        _t0 = _time.time()
        _sb_client.table("source_health").select("source").limit(1).execute()
        _sb_ping = int((_time.time() - _t0) * 1000)
    except Exception:
        _sb_ping = None
    try:
        from app.discord import client as _disc
        import httpx as _httpx
        _dt0 = _time.time()
        _tok = getattr(_disc, "TOKEN", None) or settings.DISCORD_BOT_TOKEN
        if _tok:
            with _httpx.Client(timeout=5) as _cx:
                _cx.get(
                    "https://discord.com/api/v10/gateway",
                    headers={"Authorization": f"Bot {_tok}"},
                )
            _disc_ping = int((_time.time() - _dt0) * 1000)
    except Exception:
        _disc_ping = None
    services = []
    for name in ("api", "discord", "supabase"):
        if name == "api":
            status = "healthy"
            ping = f"{_api_ping}ms" if _api_ping else None
        elif name == "discord":
            disc_ok = _disc_ping is not None
            status = "healthy" if disc_ok else "degraded"
            ping = f"{_disc_ping}ms" if _disc_ping else None
        else:
            # ponytail: degraded when Supabase ping failed (was always healthy)
            status = "healthy" if _sb_ping is not None else "degraded"
            ping = f"{_sb_ping}ms" if _sb_ping else None
        services.append({
            "name": name,
            "status": status,
            "ping": ping,
            "uptime": _fmt_uptime(_time.time() - APP_START_TS) if name == "api" else None,
        })
    # overall health: degraded if any service degraded, down if any source down
    _has_degraded = any(s["status"] == "degraded" for s in services)
    _has_down = any((r.get("status") == "down") for r in (hm or {}).values())
    _overall = "down" if _has_down else ("degraded" if _has_degraded else "healthy")
    return JSONResponse(content={
        "success": True,
        "data": {
            "services": services,
            "uptime": _fmt_uptime(_time.time() - APP_START_TS),
            "sources": hm or {},
            "status": _overall,
        },
    })





# --- Metrics (internal-only: counts per table) ---


# --- Metrics (internal-only: counts per table) ---
# Canonical JSON metrics is GET /api/metrics in app/api/system.py (cron-gated).
# This route now only serves /internal/metrics to dedup /metrics (was duplicate).
@router.get("/internal/metrics")
async def metrics_observability(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    try:
        sb = get_supabase()
        def _count(table: str) -> int:
            try:
                return sb.table(table).select("*", count="exact").execute().count or 0
            except Exception:
                return -1
        data = {
            "whitelist": _count("whitelist"),
            "recent_chapters": _count("recent_chapters"),
            "dispatch_history": _count("dispatch_history"),
            "failed_dispatches": _count("failed_dispatches"),
            "cron_run_status": _count("cron_run_status"),
            "source_health": _count("source_health"),
        }
        # merge lightweight process counters (errors_500 etc.) for unified view
        try:
            from app.metrics import snapshot as _snap
            data["counters"] = _snap().get("counters", {})
        except Exception:
            pass
        return JSONResponse(content={"success": True, "data": data})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)
