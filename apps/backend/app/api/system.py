"""System endpoints: cron trigger, cleanup (retention), metrics."""
import threading
import time as _time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_cron_auth, require_monitor_auth

logger = get_logger("api:system")
router = APIRouter()

# Cron concurrency guard: prevent overlapping runs that cause duplicate sends
# and DB contention. Uses a threading lock (process-wide) + DB advisory lock
# (cross-process/replica) so two pods/instances don't double-send.
# Per-action locks so rss-fetch isn't blocked by update and vice versa.
_cron_locks: dict[str, threading.Lock] = {
    "update": threading.Lock(),
    "rss-fetch": threading.Lock(),
    "dispatch": threading.Lock(),
    "health": threading.Lock(),
    "rss-fetch:ikiru": threading.Lock(),
    "rss-fetch:shinigami": threading.Lock(),
    "rss-fetch:voratoon": threading.Lock(),
    "enrich": threading.Lock(),
    "enrich-missing": threading.Lock(),
    "enrich-refresh": threading.Lock(),
}
_cron_running = False
_CRON_ADVISORY_KEY = 424242  # arbitrary stable int for pg_advisory_lock


# Lightweight in-memory cron job registry so callers can poll run status
# instead of inferring it from the cronStatus timestamp. Last N jobs kept.
_cron_jobs: list[dict] = []
_CRON_JOBS_MAX = 20


def _record_job(action: str, status: str, stats: dict | None = None):
    _cron_jobs.insert(0, {
        "action": action,
        "status": status,
        "started_at": _time.time(),
        "stats": stats,
    })
    while len(_cron_jobs) > _CRON_JOBS_MAX:
        _cron_jobs.pop()


def get_cron_jobs() -> list[dict]:
    return list(_cron_jobs)


def get_cron_lock(action: str) -> threading.Lock:
    """Expose the per-action cron lock so other modules (e.g. dispatches'
    retry-all) can reuse the SAME lock and avoid double-running update."""
    return _cron_locks.get(action, _cron_locks["update"])


def _run_pipeline_bg(action: str):
    """Run pipeline in a daemon thread (cron endpoint fires and forgets).

    Concurrency guard: per-action threading.Lock prevents overlapping
    runs of the SAME action. rss-fetch and update can run concurrently.
    The DB advisory lock is ONLY used to avoid two long `rss-fetch`
    scrapes running at once — it must never block `update`/`dispatch` runs.
    """
    global _cron_running
    lock = _cron_locks.get(action, _cron_locks["update"])
    if not lock.acquire(blocking=False):
        logger.warn("cron skipped: action=%s already running (in-process lock)", action=action)
        _record_job(action, "skipped")
        return
    _cron_running = True
    _db_conn = None
    _has_db_lock = False
    try:
        # Only `rss-fetch` (the slow scrape) takes the cross-process lock.
        if action == "rss-fetch":
            try:
                from app.db import get_conn, put_conn
                _db_conn = get_conn()
                cur = _db_conn.cursor()
                cur.execute("SELECT pg_try_advisory_lock(%s)", (_CRON_ADVISORY_KEY,))
                _has_db_lock = bool(cur.fetchone()[0])
                if not _has_db_lock:
                    logger.warn("cron skipped: rss-fetch already running (DB advisory lock)")
                    put_conn(_db_conn)
                    _db_conn = None
                    return
            except Exception as e:
                logger.warn("cron DB lock check failed, proceeding without it", err=str(e)[:120])
                _has_db_lock = False
                if _db_conn:
                    try:
                        from app.db import put_conn as _pc
                        _pc(_db_conn)
                    except Exception:
                        pass
                    _db_conn = None

        from app.cron.pipeline import run_pipeline
        if action == "sync-meta":
            from app.cron.series_meta_sync import sync_series_meta
            _record_job(action, "running")
            stats = sync_series_meta()
            _record_job(action, "done", stats)
            logger.info("cron series-meta sync done", **stats)
            return
        if action == "enrich":
            from app.cron.enrich_resync import enrich_recent_chapters
            _record_job(action, "running")
            stats = enrich_recent_chapters()
            _record_job(action, "done", stats)
            logger.info("cron enrich resync done", **stats)
            return
        if action == "enrich-missing":
            from app.cron.enrich_resync import enrich_recent_chapters as _enrich_miss
            _record_job(action, "running")
            stats = _enrich_miss(limit=100, miss_only=True)
            _record_job(action, "done", stats)
            logger.info("cron enrich-missing done", **stats)
            return
        if action == "enrich-refresh":
            from app.cron.enrich_resync import enrich_stale_series_meta
            _record_job(action, "running")
            stats = enrich_stale_series_meta(stale_days=7, limit=50)
            _record_job(action, "done", stats)
            logger.info("cron enrich-refresh done", **stats)
            return
        if action == "health":
            from app.storage import health as hs
            from app.config import settings as _s
            hm = hs.load_source_health_map(_s.SOURCE_KEYS)
            logger.info("cron health done", sources=len(hm or {}))
        else:
            do_dispatch = action in ("update", "dispatch")
   
            # Parse source from action string (e.g., "rss-fetch:ikiru" → source="ikiru")
            source = None
            pipeline_action = action
            if ":" in action:
                pipeline_action, source = action.split(":", 1)
   
            _record_job(action, "running")
            stats = run_pipeline(do_dispatch=do_dispatch, action=action)
            _record_job(action, "done", stats)
            logger.info("cron pipeline done", action=action, stats=stats)
    except Exception as e:
        logger.error("cron pipeline failed", action=action, exc=e)
    finally:
        _cron_running = False
        if _has_db_lock and _db_conn:
            try:
                cur = _db_conn.cursor()
                cur.execute("SELECT pg_advisory_unlock(%s)", (_CRON_ADVISORY_KEY,))
                _db_conn.commit()
            except Exception:
                try:
                    _db_conn.rollback()
                except Exception:
                    pass
            try:
                from app.db import put_conn as _pc2
                _pc2(_db_conn)
            except Exception:
                pass
        elif _db_conn:
            try:
                from app.db import put_conn as _pc3
                _pc3(_db_conn)
            except Exception:
                pass
        # ALWAYS release the in-process lock — this is the critical fix.
        lock.release()


@router.get("/cron")
@router.post("/cron")
async def cron_trigger(request: Request):
    if not require_cron_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    action = request.query_params.get("action", "update")
    source = request.query_params.get("source")
    
    # Build action string: "rss-fetch:ikiru", "rss-fetch:shinigami", "rss-fetch:voratoon"
    if source and action == "rss-fetch":
        action = f"rss-fetch:{source}"
    
    valid_actions = ("update", "rss-fetch", "health", "dispatch", "sync-meta", "enrich", "enrich-missing", "enrich-refresh")
    valid_source_actions = ("rss-fetch:ikiru", "rss-fetch:shinigami", "rss-fetch:voratoon")
    
    if action not in valid_actions and action not in valid_source_actions:
        return JSONResponse(content={"success": False, "error": f"unknown action: {action}"}, status_code=400)
    # Decoupled: enqueue to Redis cron queue; the ROLE=cron worker executes.
    # Keeps the slow scrape/dispatch off the HTTP path. Falls back to inline
    # execution if Redis is unavailable.
    from app.tasks import enqueue_cron
    enqueue_cron(action)
    return JSONResponse(content={"success": True, "data": {"status": "enqueued", "action": action}}, status_code=202)


@router.get("/cron/status")
async def cron_status(request: Request):
    """Return recent cron job runs (in-memory) so the FE can show real run
    status instead of inferring it from the cronStatus timestamp."""
    if not (require_cron_auth(request) or require_monitor_auth(request)):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    jobs = get_cron_jobs()
    return JSONResponse(content={"success": True, "data": {"jobs": jobs, "running": _cron_running}})


@router.get("/cleanup")
async def cleanup(request: Request):
    if not require_cron_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.db import get_supabase
        from datetime import datetime, timedelta, timezone
        cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        sb = get_supabase()
        r1 = sb.table("dispatch_history").delete().lt("sent_at", cutoff).execute()
        deleted = len(r1.data) if r1.data else 0
        logger.info("cleanup done", deleted=deleted)
        return JSONResponse(content={"success": True, "data": {"deleted_old": deleted}})
    except Exception as e:
        return JSONResponse(content={"success": False, "error": str(e)[:300]}, status_code=500)


@router.get("/metrics")
async def metrics(request: Request):
    # Accepts either cron or monitor auth (unified JSON metrics endpoint).
    from app.utils.request_auth import require_monitor_auth
    if not (require_cron_auth(request) or require_monitor_auth(request)):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.db import get_supabase
        from app.metrics import snapshot as _snap
        sb = get_supabase()
        rc = sb.table("recent_chapters").select("id", count="exact").limit(1).execute()
        wl = sb.table("whitelist").select("id", count="exact").limit(1).execute()
        dh = sb.table("dispatch_history").select("id", count="exact").limit(1).execute()
        return JSONResponse(content={
            "success": True,
            "data": {
                "recent_chapters_count": rc.count or 0,
                "whitelist_count": wl.count or 0,
                "dispatch_history_count": dh.count or 0,
                "counters": _snap().get("counters", {}),
            },
        })
    except Exception as e:
        return JSONResponse(content={"success": False, "error": str(e)[:300]}, status_code=500)
