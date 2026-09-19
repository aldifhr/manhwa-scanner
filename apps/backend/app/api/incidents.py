"""Incidents — generated from real backend state."""
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import int_safe, safe_error, require_monitor_auth

logger = get_logger("api:incidents")
router = APIRouter()


@router.get("/incidents")
async def incidents(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    action = request.query_params.get("action", "")
    days_back = int_safe(request.query_params.get("days", "30"), 30, max_val=90)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()
    now = datetime.now(timezone.utc)

    try:
        sb = get_supabase()
        timeline = []
        ongoing = []
        by_severity = {"critical": 0, "high": 0, "medium": 0, "low": 0}
        by_type = {}
        by_status = {"resolved": 0, "ongoing": 0}
        notices = []

        try:
            cron = (
                sb.table("cron_run_status")
                .select("status, created_at, duration, chapters_sent, matched")
                .gte("created_at", cutoff)
                .order("created_at", desc=True)
                .limit(200)
                .execute()
            )
            for row in cron.data or []:
                if row.get("status") != "ok":
                    ts = row.get("created_at", "")
                    dur = row.get("duration")
                    dur_s = f"{dur}s" if dur is not None else "unknown"
                    sent = row.get("chapters_sent")
                    timeline.append({"type": "Cron Failure", "message": f"Cron run failed (duration {dur_s}, sent {sent})", "timestamp": ts})
                    by_severity["high"] += 1
                    by_type["cron"] = by_type.get("cron", 0) + 1
                    by_status["ongoing"] += 1
                    ongoing.append({"type": "Cron Failure", "timestamp": ts})
        except Exception:
            pass

        try:
            fd = (
                sb.table("failed_dispatches")
                .select("chapter_url, source, error_message, created_at")
                .gte("created_at", cutoff)
                .order("created_at", desc=True)
                .limit(200)
                .execute()
            )
            for row in fd.data or []:
                ts = row.get("created_at", "")
                msg = f"Failed to notify {row.get('source', '?')} chapter: {row.get('error_message', 'unknown error')[:80]}"
                timeline.append({"type": "Dispatch Failure", "message": msg, "timestamp": ts})
                by_severity["critical"] += 1
                by_type["dispatch"] = by_type.get("dispatch", 0) + 1
                by_status["ongoing"] += 1
                ongoing.append({"type": "Dispatch Failure", "timestamp": ts})
                notices.append({"message": msg, "severity": "critical", "source": row.get("source", ""), "timestamp": ts})
        except Exception:
            pass

        try:
            sh = sb.table("source_health").select("*").execute()
            for row in sh.data or []:
                cf = row.get("consecutive_failures") or 0
                status = row.get("status", "healthy")
                src = row.get("source", "?")
                if status == "down" or cf >= 3:
                    by_severity["high"] += 1
                    by_type["source"] = by_type.get("source", 0) + 1
                    by_status["ongoing"] += 1
                    msg = f"Source '{src}' degraded: {cf} consecutive failures"
                    timeline.append({"type": "Source Degraded", "message": msg, "timestamp": row.get("last_checked_at", "")})
                    ongoing.append({"type": "Source Degraded", "timestamp": row.get("last_checked_at", "")})
                    notices.append({"message": msg, "severity": "high", "source": src, "timestamp": row.get("last_checked_at", "")})
                elif cf > 0:
                    by_severity["medium"] += 1
                    by_type["source"] = by_type.get("source", 0) + 1
                    notices.append({"message": f"Source '{src}': {cf} transient failures", "severity": "medium", "source": src, "timestamp": row.get("last_checked_at", "")})
        except Exception:
            pass

        if action == "notices":
            notice_cutoff = (now - timedelta(days=days_back)).isoformat()
            filtered = [n for n in notices if (n.get("timestamp") or "") >= notice_cutoff]
            return JSONResponse(content={
                "success": True,
                "data": {"notices": filtered, "totalNotices": len(filtered), "hasNotices": len(filtered) > 0, "days": days_back},
            })

        timeline.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        recent24h = sum(1 for t in timeline if t.get("timestamp", "") >= (now - timedelta(hours=24)).isoformat())
        resolved_count = max(0, len(timeline) - len(ongoing))

        return JSONResponse(content={
            "success": True,
            "data": {
                "results": timeline,
                "notices": notices,
                "total": len(timeline),
                "stats": {"byType": by_type, "bySeverity": by_severity, "byStatus": {"resolved": resolved_count, "ongoing": len(ongoing)}},
                "timeline": timeline,
                "daysBack": days_back,
                "totalCount": len(timeline),
                "recent24h": recent24h,
                "ongoingCount": len(ongoing),
            },
        })
    except Exception:
        return JSONResponse(content={
            "success": True,
            "data": {
                "results": [], "notices": [], "total": 0,
                "stats": {"byType": {}, "bySeverity": by_severity, "byStatus": {"resolved": 0, "ongoing": 0}},
                "timeline": [], "daysBack": days_back, "totalCount": 0, "recent24h": 0, "ongoingCount": 0,
            },
        })
