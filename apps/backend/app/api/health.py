"""Health endpoints — extracted from main.py god-file."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import safe_error, require_monitor_auth

logger = get_logger("api:health")
router = APIRouter()


@router.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "be-ag-py"}


@router.get("/health")
async def api_health(request: Request):
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
                "lastScrapeAt": max((s["lastScrape"] for s in sources), default=""),
                "service": "be-ag-py",
            },
        })
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


def _parse_voratoon_expiry(cover: str) -> tuple[str | None, float | None]:
    """Parse X-Amz-Date/X-Amz-Expires from presigned voratoon cover. Returns (expiry_iso, hours_remaining) or (None, None)."""
    if not cover or "cvr.voratoon.id" not in cover:
        return None, None
    import re as _re
    import time as _time
    from datetime import datetime as _dt, timezone as _tz
    m = _re.search(r"X-Amz-Date=([^&]+).*?X-Amz-Expires=(\d+)", cover)
    if not m:
        return None, None
    try:
        d = m.group(1)
        exp = int(m.group(2))
        dt = _dt.strptime(d, "%Y%m%dT%H%M%SZ").replace(tzinfo=_tz.utc)
        expiry_ts = dt.timestamp() + exp
        expiry_iso = _dt.fromtimestamp(expiry_ts, tz=_tz.utc).isoformat()
        hours_remaining = (expiry_ts - _time.time()) / 3600
        return expiry_iso, round(hours_remaining, 1)
    except Exception:
        return None, None


@router.post("/health/refresh-voratoon")
async def refresh_voratoon(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.cron.enrich_whitelist import enrich_all_whitelist
        # force refresh voratoon expiring soon (5d window) — reuse same logic
        count = enrich_all_whitelist(refresh_days=5)
        return JSONResponse(content={"success": True, "data": {"refreshed": count}})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.get("/health/detailed")
async def health_detailed(request: Request):
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
    down_count = sum(1 for s in sources if s["status"] == "down")
    degraded_count = sum(1 for s in sources if s["status"] == "degraded")
    overall = "down" if down_count > 0 else ("degraded" if degraded_count > 0 else "healthy")
    import time as _t_up
    _uptime_s = _t_up.time() - health_store.APP_START_TS if hasattr(health_store, "APP_START_TS") else 0
    if not _uptime_s:
        try:
            from app.api.observability import APP_START_TS as _api_start
            _uptime_s = _t_up.time() - _api_start
        except Exception:
            _uptime_s = 0
    _avg_err = sum(s["errorRate24h"] for s in sources) / len(sources) if sources else 0
    _uptime_pct = round(max(0, 100 - _avg_err), 1) if sources else 100.0
    # voratoon whitelist cover expiry countdown (reuse _is_voratoon_expiring_soon logic)
    voratoon_covers: list[dict] = []
    try:
        from app.db import get_supabase as _gsb2
        _rows = _gsb2().table("whitelist").select("title_key, title, cover").eq("source", "voratoon").limit(100).execute().data or []
        for _r in _rows:
            _cover = _r.get("cover") or ""
            if "cvr.voratoon.id" not in _cover:
                continue
            expiry_iso, hours_remaining = _parse_voratoon_expiry(_cover)
            if expiry_iso is None:
                continue
            voratoon_covers.append({
                "title_key": _r.get("title_key", ""),
                "title": _r.get("title", ""),
                "cover": _cover,
                "expiry": expiry_iso,
                "hours_remaining": hours_remaining,
                "expiring_soon": (hours_remaining is not None and hours_remaining < 24),
                "expired": (hours_remaining is not None and hours_remaining < 0),
            })
        voratoon_covers.sort(key=lambda x: x["hours_remaining"] if x["hours_remaining"] is not None else 9999)
    except Exception:
        voratoon_covers = []
    return {
        "success": True,
        "data": {
            "sources": sources,
            "overall": overall,
            "uptime": _uptime_pct,
            "uptime_human": f"{int(_uptime_s//3600)}h {int((_uptime_s%3600)//60)}m" if _uptime_s else "0m",
            "version": "1.0.0",
            "circuit_breakers": {
                "discord": cb_discord.state.value,
                "db": cb_db.state.value,
                "ikiru": cb_ikiru.state.value,
                "shinigami": cb_shinigami.state.value,
                "voratoon": cb_voratoon.state.value,
            },
            "db_pool": pool,
            "voratoon_covers": voratoon_covers,
        }
    }
