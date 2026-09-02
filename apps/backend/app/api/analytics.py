"""Analytics dashboard — popular series, chapter velocity, engagement metrics."""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:analytics")
router = APIRouter()


@router.get("/analytics/overview")
async def analytics_overview(request: Request):
    """Overview analytics — popular series, velocity, engagement."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        from app.db import q

        # Most popular series (by dispatch count, last 7 days)
        popular_series = q("""
            SELECT dh.title_key, dh.source, COUNT(*) as dispatch_count,
                   MAX(dh.sent_at) as last_dispatched
            FROM dispatch_history dh
            WHERE dh.sent_at >= NOW() - INTERVAL '7 days'
            GROUP BY dh.title_key, dh.source
            ORDER BY dispatch_count DESC
            LIMIT 20
        """)

        # Chapter velocity (avg chapters per day, last 7 days)
        velocity = q("""
            SELECT 
                DATE(sent_at) as date,
                COUNT(*) as total_dispatches,
                COUNT(DISTINCT title_key) as unique_series
            FROM dispatch_history
            WHERE sent_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(sent_at)
            ORDER BY date DESC
        """)

        # Source distribution
        source_dist = q("""
            SELECT source, COUNT(*) as count
            FROM dispatch_history
            WHERE sent_at >= NOW() - INTERVAL '7 days'
            GROUP BY source
            ORDER BY count DESC
        """)

        # Whitelist growth (new entries per day, last 30 days)
        whitelist_growth = q("""
            SELECT DATE(created_at) as date, COUNT(*) as new_entries
            FROM whitelist
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        """)

        # Failed dispatch rate
        failed_stats = q("""
            SELECT 
                COUNT(*) as total_failed,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as still_failed,
                COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
                COUNT(CASE WHEN status = 'permanent_failure' THEN 1 END) as permanent
            FROM failed_dispatches
            WHERE created_at >= NOW() - INTERVAL '7 days'
        """)

        # Top genres (from series_meta)
        top_genres = q("""
            SELECT jsonb_array_elements_text(genres) as genre, COUNT(*) as count
            FROM series_meta
            WHERE genres IS NOT NULL AND genres != '[]'::jsonb
            GROUP BY genre
            ORDER BY count DESC
            LIMIT 15
        """)

        return JSONResponse(content={
            "success": True,
            "data": {
                "popular_series": popular_series,
                "chapter_velocity": velocity,
                "source_distribution": source_dist,
                "whitelist_growth": whitelist_growth,
                "failed_dispatch_stats": failed_stats[0] if failed_stats else {},
                "top_genres": top_genres,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
        })
    except Exception as e:
        logger.warn("analytics_overview failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/analytics/series/{title_key}")
async def analytics_series_detail(request: Request, title_key: str):
    """Detailed analytics for a specific series."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        from app.db import q

        # Series info
        series_info = q("""
            SELECT w.title_key, w.source, w.title, w.cover, w.rating, w.genres, w.status,
                   w.latest_sent_chapter, w.latest_chapter, w.created_at
            FROM whitelist w
            WHERE w.title_key = %s
            LIMIT 1
        """, [title_key])

        if not series_info:
            return JSONResponse(content={"success": False, "error": "series not found"}, status_code=404)

        # Dispatch history for this series
        dispatch_history = q("""
            SELECT chapter_title, sent_at
            FROM dispatch_history
            WHERE title_key = %s
            ORDER BY sent_at DESC
            LIMIT 50
        """, [title_key])

        # Chapter velocity (chapters per week)
        velocity = q("""
            SELECT 
                DATE_TRUNC('week', sent_at) as week,
                COUNT(*) as chapters_dispatched
            FROM dispatch_history
            WHERE title_key = %s AND sent_at >= NOW() - INTERVAL '12 weeks'
            GROUP BY DATE_TRUNC('week', sent_at)
            ORDER BY week DESC
        """, [title_key])

        return JSONResponse(content={
            "success": True,
            "data": {
                "series": series_info[0],
                "dispatch_history": dispatch_history,
                "velocity": velocity,
            }
        })
    except Exception as e:
        logger.warn("analytics_series_detail failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/analytics/engagement")
async def analytics_engagement(request: Request):
    """User engagement metrics — reading activity, active users."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        from app.db import q

        # Active reading sessions (last 24h)
        active_sessions = q("""
            SELECT COUNT(DISTINCT session_hash) as active_users
            FROM continue_reading
            WHERE updated_at >= NOW() - INTERVAL '24 hours'
        """)

        # Total reading progress entries
        total_progress = q("""
            SELECT COUNT(*) as total_sessions,
                   SUM(jsonb_object_keys(entries)::int) as total_entries
            FROM continue_reading
        """)

        # Most read series (by continue_reading entries)
        most_read = q("""
            SELECT key as title_key, COUNT(*) as reader_count
            FROM continue_reading, jsonb_object_keys(entries) as key
            GROUP BY key
            ORDER BY reader_count DESC
            LIMIT 20
        """)

        # Reading activity over time (last 30 days)
        activity = q("""
            SELECT DATE(updated_at) as date, COUNT(*) as active_users
            FROM continue_reading
            WHERE updated_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(updated_at)
            ORDER BY date DESC
        """)

        return JSONResponse(content={
            "success": True,
            "data": {
                "active_sessions_24h": active_sessions[0]["active_users"] if active_sessions else 0,
                "total_reading_sessions": total_progress[0]["total_sessions"] if total_progress else 0,
                "most_read_series": most_read,
                "activity_over_time": activity,
            }
        })
    except Exception as e:
        logger.warn("analytics_engagement failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
