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


def _refresh_voratoon_cover(slug: str) -> str | None:
    """Fetch fresh presigned voratoon cover for a slug."""
    try:
        from app.scrapers import voratoon as _vt
        d = _vt.fetch_series_detail(slug)
        if d and d.get("data"):
            cover = d["data"].get("coverImage")
            if cover:
                from app.utils.cover_scrub import scrub_cover
                return scrub_cover(cover) or cover
    except Exception as e:
        logger.debug("voratoon cover refresh failed", slug=slug, err=str(e)[:120])
    return None


def _is_voratoon_expiring(cover: str | None) -> bool:
    """Check if voratoon presigned URL expires within 24h."""
    if not cover or "cvr.voratoon.id" not in cover:
        return False
    from app.config import settings as _cfg
    if _cfg.VORATOON_COVER_BUCKET not in cover:
        return False
    from datetime import datetime, timedelta, timezone
    import re as _re
    m = _re.search(r"X-Amz-Date=([^&]+).*?X-Amz-Expires=(\d+)", cover)
    if not m:
        return False
    try:
        d = m.group(1)
        exp = int(m.group(2))
        from datetime import datetime as _dt
        dt = _dt.strptime(d, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        expiry_ts = dt.timestamp() + exp
        return (expiry_ts - datetime.now(timezone.utc).timestamp()) < 86400
    except Exception:
        return False


def refresh_all_voratoon_covers(force: bool = False, limit: int = 200) -> dict:
    """Scan voratoon covers across tables, refresh expiring presigned URLs."""
    from app.db import get_supabase
    sb = get_supabase()
    updated = 0
    scanned = 0

    tables = [
        ("whitelist", "title_key, cover, source"),
        ("series_meta", "title_key, cover, source"),
        ("recent_chapters", "title_key, cover, source"),
        ("excluded_titles", "title_key, cover, source"),
    ]

    for table, select_cols in tables:
        try:
            rows = sb.table(table).select(select_cols).eq("source", "voratoon").limit(limit).execute().data or []
            for r in rows:
                cover = r.get("cover")
                if not force and not _is_voratoon_expiring(cover):
                    continue
                slug = r.get("title_key")
                if not slug:
                    continue
                scanned += 1
                new_cover = _refresh_voratoon_cover(slug)
                if new_cover:
                    try:
                        sb.table(table).update({"cover": new_cover}).eq("title_key", slug).eq("source", "voratoon").execute()
                        updated += 1
                    except Exception:
                        pass
        except Exception as e:
            logger.warn(f"voratoon scan failed: {table}", err=str(e)[:120])

    return {"scanned": scanned, "updated": updated}


@router.post("/health/refresh-voratoon")
async def refresh_voratoon(request: Request):
    """Force refresh voratoon covers (bypass throttle)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        result = refresh_all_voratoon_covers(force=True)
        return JSONResponse(content={"success": True, "data": {"refreshed": result["updated"], "scanned": result["scanned"]}})
    except Exception as e:
        logger.warn("refresh-voratoon failed", err=str(e)[:200])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


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
