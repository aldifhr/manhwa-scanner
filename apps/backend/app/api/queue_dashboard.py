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
        
        # Parse job info + breakdown
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
        
        # Breakdown cron jobs by action
        cron_breakdown: dict[str, int] = {}
        try:
            all_cron = r.lrange(CRON_QUEUE_KEY, 0, -1) or []
            for j in all_cron:
                try:
                    data = json.loads(j)
                    action = data.get("action", "unknown")
                    # Normalize: rss-fetch:ikiru → rss-fetch
                    key = action.split(":")[0] if ":" in action else action
                    cron_breakdown[key] = cron_breakdown.get(key, 0) + 1
                except Exception:
                    cron_breakdown["unknown"] = cron_breakdown.get("unknown", 0) + 1
        except Exception:
            pass
        
        # Pending dispatch chapters (whitelisted, unsent)
        pending_chapters = []
        try:
            from app.db import get_supabase
            from app.cron.collect import filter_whitelisted
            from app.cron.dispatch_mod import fcfs_key as _fk, _claimed_titles
            from app.utils.text import normalize_title_key as _ntk
            from app.storage import whitelist as wl_store
            from datetime import datetime, timezone, timedelta
            
            sb = get_supabase()
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
            rc = sb.table("recent_chapters").select("id,title_key,source,chapter,chapter_num,title,chapter_url").gte("updated_time", cutoff).execute().data or []
            wl = wl_store.load_whitelist()
            wl_keys = {(_ntk(str(w.get("title_key", ""))), w.get("source", "")) for w in wl}
            whitelisted = [c for c in rc if (_ntk(str(c.get("title_key", ""))), c.get("source", "")) in wl_keys]
            ceil = {}
            for w in wl:
                tk = _ntk(str(w.get("title_key", "")))
                src = w.get("source", "")
                try:
                    ls = float(w.get("latest_sent_chapter") or 0)
                except Exception:
                    ls = 0
                if tk:
                    ceil[(tk, src)] = max(ceil.get((tk, src), 0), ls)
            pending = []
            for c in whitelisted:
                tk = _ntk(str(c.get("title_key", "")))
                src = c.get("source", "")
                c_ceil = ceil.get((tk, src), ceil.get((tk, ""), 0))
                try:
                    ch = float(c.get("chapter_num") or c.get("chapter") or 0)
                except Exception:
                    ch = 0
                if c_ceil and ch <= c_ceil:
                    continue
                pending.append(c)
            keys = [_fk(c.get("title", ""), c.get("chapter", "")) for c in pending]
            claimed = _claimed_titles(list(set(keys))) if keys else set()
            final = [c for i, c in enumerate(pending) if keys[i] not in claimed]
            pending_chapters = [
                {
                    "id": c.get("id"),
                    "title": c.get("title", ""),
                    "title_key": c.get("title_key", ""),
                    "chapter": c.get("chapter", ""),
                    "chapter_num": float(c.get("chapter_num") or 0),
                    "source": c.get("source", ""),
                    "chapter_url": c.get("chapter_url", ""),
                }
                for c in final[:50]
            ]
        except Exception as e:
            logger.warn("pending_chapters failed", err=str(e)[:120])
        
        return JSONResponse(content={
            "success": True,
            "data": {
                "depth": main_queue + cron_queue,
                "dlq": dlq,
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
                "cron_breakdown": cron_breakdown,
                "pending_chapters": pending_chapters,
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


@router.delete("/api/v1/queue/pending")
async def clear_pending(request: Request):
    """Mark all pending chapters as dispatched (add to dispatch_history)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.db import get_supabase
        from app.cron.collect import filter_whitelisted
        from app.cron.dispatch_mod import fcfs_key as _fk, _claimed_titles
        from app.utils.text import normalize_title_key as _ntk
        from app.storage import whitelist as wl_store
        from datetime import datetime, timezone, timedelta
        
        sb = get_supabase()
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        rc = sb.table("recent_chapters").select("id,title_key,source,chapter,chapter_num,title,chapter_url").gte("updated_time", cutoff).execute().data or []
        wl = wl_store.load_whitelist()
        wl_keys = {(_ntk(str(w.get("title_key", ""))), w.get("source", "")) for w in wl}
        whitelisted = [c for c in rc if (_ntk(str(c.get("title_key", ""))), c.get("source", "")) in wl_keys]
        ceil = {}
        for w in wl:
            tk = _ntk(str(w.get("title_key", "")))
            src = w.get("source", "")
            try:
                ls = float(w.get("latest_sent_chapter") or 0)
            except Exception:
                ls = 0
            if tk:
                ceil[(tk, src)] = max(ceil.get((tk, src), 0), ls)
        pending = []
        for c in whitelisted:
            tk = _ntk(str(c.get("title_key", "")))
            src = c.get("source", "")
            c_ceil = ceil.get((tk, src), ceil.get((tk, ""), 0))
            try:
                ch = float(c.get("chapter_num") or c.get("chapter") or 0)
            except Exception:
                ch = 0
            if c_ceil and ch <= c_ceil:
                continue
            pending.append(c)
        keys = [_fk(c.get("title", ""), c.get("chapter", "")) for c in pending]
        claimed = _claimed_titles(list(set(keys))) if keys else set()
        final = [c for i, c in enumerate(pending) if keys[i] not in claimed]
        
        # Mark as dispatched by adding to dispatch_history
        now = datetime.now(timezone.utc).isoformat()
        history_rows = []
        for c in final:
            history_rows.append({
                "title_key": _ntk(str(c.get("title_key", ""))),
                "title": c.get("title", ""),
                "chapter_title": c.get("chapter", ""),
                "source": c.get("source", ""),
                "chapter_url": c.get("chapter_url", ""),
                "created_at": now,
            })
        if history_rows:
            sb.table("dispatch_history").insert(history_rows).execute()
        
        return JSONResponse(content={"success": True, "data": {"cleared": len(history_rows)}})
    except Exception as e:
        logger.warn("clear_pending failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
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
