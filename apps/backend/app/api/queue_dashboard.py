"""Queue dashboard — Redis queue monitoring for admin insight."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:queue_dashboard")
router = APIRouter()


@router.get("/api/v1/queue/status")
async def queue_status(request: Request):
    """Redis queue status — pending jobs, DLQ depth, recent activity."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.tasks import _get_redis, QUEUE_KEY, CRON_QUEUE_KEY, DLQ_KEY
        
        r = _get_redis()
        
        # Queue depths
        main_queue = r.llen(QUEUE_KEY) or 0
        cron_queue = r.llen(CRON_QUEUE_KEY) or 0
        dlq = r.llen(DLQ_KEY) or 0
        
        # Peek at first 5 jobs in each queue
        main_jobs = r.lrange(QUEUE_KEY, 0, 4) or []
        cron_jobs = r.lrange(CRON_QUEUE_KEY, 0, 4) or []
        dlq_jobs = r.lrange(DLQ_KEY, 0, 4) or []
        
        # Parse job info
        import json
        def parse_jobs(raw_jobs):
            result = []
            for j in raw_jobs:
                try:
                    data = json.loads(j)
                    result.append({
                        "kind": data.get("kind", "unknown"),
                        "title": data.get("title", data.get("action", "unknown"))[:50],
                        "attempts": data.get("attempts", 0),
                    })
                except Exception:
                    result.append({"raw": j[:100]})
            return result
        
        return JSONResponse(content={
            "success": True,
            "data": {
                "depths": {
                    "main_queue": main_queue,
                    "cron_queue": cron_queue,
                    "dead_letter_queue": dlq,
                },
                "pending_jobs": {
                    "main": parse_jobs(main_jobs),
                    "cron": parse_jobs(cron_jobs),
                    "dlq": parse_jobs(dlq_jobs),
                },
            }
        })
    except Exception as e:
        logger.warn("queue_status failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.post("/api/v1/queue/retry-dlq")
async def retry_dlq(request: Request):
    """Move all DLQ jobs back to main queue for retry."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.tasks import _get_redis, QUEUE_KEY, DLQ_KEY
        
        r = _get_redis()
        count = 0
        while True:
            job = r.rpoplpush(DLQ_KEY, QUEUE_KEY)
            if not job:
                break
            count += 1
        
        return JSONResponse(content={"success": True, "data": {"retried": count}})
    except Exception as e:
        logger.warn("retry_dlq failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.delete("/api/v1/queue/dlq")
async def clear_dlq(request: Request):
    """Clear all jobs from dead letter queue."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.tasks import _get_redis, DLQ_KEY
        
        r = _get_redis()
        count = r.llen(DLQ_KEY) or 0
        r.delete(DLQ_KEY)
        
        return JSONResponse(content={"success": True, "data": {"deleted": count}})
    except Exception as e:
        logger.warn("clear_dlq failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
