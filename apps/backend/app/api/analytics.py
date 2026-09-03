"""Analytics dashboard — popular series, chapter velocity, engagement metrics."""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:analytics")
router = APIRouter()


class PopularSeriesItem(BaseModel):
    model_config = {"extra": "allow"}
    title_key: str
    source: str
    dispatch_count: int
    last_dispatched: str | None = None


class VelocityItem(BaseModel):
    model_config = {"extra": "allow"}
    date: str
    total_dispatches: int
    unique_series: int


class SourceDistItem(BaseModel):
    model_config = {"extra": "allow"}
    source: str
    count: int


class WhitelistGrowthItem(BaseModel):
    model_config = {"extra": "allow"}
    date: str
    new_entries: int


class FailedStats(BaseModel):
    model_config = {"extra": "allow"}
    total_failed: int = 0
    still_failed: int = 0
    resolved: int = 0
    permanent: int = 0


class GenreItem(BaseModel):
    model_config = {"extra": "allow"}
    genre: str
    count: int


class AnalyticsOverviewResponse(BaseModel):
    model_config = {"extra": "allow"}
    popular_series: list[PopularSeriesItem]
    chapter_velocity: list[VelocityItem]
    source_distribution: list[SourceDistItem]
    whitelist_growth: list[WhitelistGrowthItem]
    failed_dispatch_stats: FailedStats
    top_genres: list[GenreItem]
    generated_at: str


class EngagementResponse(BaseModel):
    model_config = {"extra": "allow"}
    active_sessions_24h: int
    total_reading_sessions: int
    most_read_series: list[dict[str, Any]]
    activity_over_time: list[dict[str, Any]]


class AnalyticsOverviewEnvelope(BaseModel):
    model_config = {"extra": "allow"}
    success: bool
    data: AnalyticsOverviewResponse


class EngagementEnvelope(BaseModel):
    model_config = {"extra": "allow"}
    success: bool
    data: EngagementResponse


@router.get("/analytics/overview", response_model=AnalyticsOverviewEnvelope)
async def analytics_overview(request: Request):
    """Overview analytics — popular series, velocity, engagement."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    from app.db import q

    def _safe(sql: str, params=None, fallback=None):
        try:
            return q(sql, params) if params else q(sql)
        except Exception as e:
            logger.warn("analytics_overview subquery failed", sql=sql[:80], err=str(e)[:160])
            return fallback if fallback is not None else []

    popular_series = _safe("""
        SELECT dh.title_key, dh.source,
               COALESCE(NULLIF(w.title,''), dh.title_key) AS title,
               COUNT(*) as dispatch_count,
               MAX(dh.sent_at) as last_dispatched
        FROM dispatch_history dh
        LEFT JOIN whitelist w ON REPLACE(LOWER(w.title_key), '-', ' ') = REPLACE(LOWER(dh.title_key), '-', ' ') AND w.source = dh.source
        WHERE dh.sent_at >= NOW() - INTERVAL '7 days'
        GROUP BY dh.title_key, dh.source, w.title
        ORDER BY dispatch_count DESC
        LIMIT 20
    """)
    velocity = _safe("""
        SELECT DATE(sent_at) as date,
               COUNT(*) as total_dispatches,
               COUNT(DISTINCT title_key) as unique_series
        FROM dispatch_history
        WHERE sent_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(sent_at)
        ORDER BY date DESC
    """)
    source_dist = _safe("""
        SELECT source, COUNT(*) as count
        FROM dispatch_history
        WHERE sent_at >= NOW() - INTERVAL '7 days'
        GROUP BY source
        ORDER BY count DESC
    """)
    whitelist_growth = _safe("""
        SELECT DATE(created_at) as date, COUNT(*) as new_entries
        FROM whitelist
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
    """)
    failed_stats = _safe("""
        SELECT COUNT(*) as total_failed,
               COUNT(CASE WHEN status = 'failed' THEN 1 END) as still_failed,
               COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
               COUNT(CASE WHEN status = 'permanent_failure' THEN 1 END) as permanent
        FROM failed_dispatches
        WHERE created_at >= NOW() - INTERVAL '7 days'
    """)
    top_genres = _safe("""
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


class SeriesDetailResponse(BaseModel):
    model_config = {"extra": "allow"}
    series: dict[str, Any]
    dispatch_history: list[dict[str, Any]]
    velocity: list[dict[str, Any]]


class SeriesDetailEnvelope(BaseModel):
    model_config = {"extra": "allow"}
    success: bool
    data: SeriesDetailResponse


@router.get("/analytics/series/{title_key}", response_model=SeriesDetailEnvelope)
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


class RetentionItem(BaseModel):
    model_config = {"extra": "allow"}
    title_key: str
    title: str
    dispatched_30d: int
    read_sessions: int
    retention_pct: float

class RetentionResponse(BaseModel):
    model_config = {"extra": "allow"}
    overall_retention_30d: float
    total_whitelisted: int
    retained_titles: int
    churned_titles: int
    top_retained: list[RetentionItem]
    top_churned: list[RetentionItem]

class RetentionEnvelope(BaseModel):
    model_config = {"extra": "allow"}
    success: bool
    data: RetentionResponse


@router.get("/analytics/retention", response_model=RetentionEnvelope)
async def analytics_retention(request: Request):
    """Retention: dispatched vs actually read (continue_reading) per whitelisted title.
    Uses isWhitelisted logic (title-based) via dispatch_history + continue_reading."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import q
    from app.utils.text import normalize_title_key

    def _safe(sql, params=None, fallback=None):
        try:
            return q(sql, params) if params else q(sql)
        except Exception as e:
            logger.warn("retention subquery failed", sql=sql[:80], err=str(e)[:160])
            return fallback if fallback is not None else []

    # Whitelisted titles
    wl = _safe("SELECT title_key, title FROM whitelist", fallback=[])
    wl_title_norm = {normalize_title_key(r.get("title") or r.get("title_key") or ""): r for r in wl}
    total_wl = len(wl)

    # Dispatched per title 30d
    disp = _safe("""
        SELECT title_key, COUNT(*) as cnt
        FROM dispatch_history
        WHERE sent_at >= NOW() - INTERVAL '30 days'
        GROUP BY title_key
    """, fallback=[])
    disp_map = {normalize_title_key(r.get("title_key") or ""): int(r.get("cnt") or 0) for r in disp}

    # Read sessions per title 30d (from continue_reading jsonb)
    # continue_reading.entries is jsonb per session_hash, need to unnest
    read = _safe("""
        SELECT normalize_title_key(key) as nk, COUNT(*) as readers
        FROM continue_reading, jsonb_object_keys(entries) as key
        WHERE to_timestamp(updated_at) >= NOW() - INTERVAL '30 days'
        GROUP BY nk
    """, fallback=[])
    # Fallback if normalize_title_key SQL func not exists -> do in Python
    if not read:
        # Python fallback: fetch all entries and count in Python
        try:
            rows = _safe("SELECT entries FROM continue_reading WHERE to_timestamp(updated_at) >= NOW() - INTERVAL '30 days'", fallback=[])
            from collections import Counter
            cnt = Counter()
            for r in rows:
                ents = r.get("entries") or {}
                if isinstance(ents, dict):
                    for k in ents.keys():
                        cnt[normalize_title_key(k)] += 1
            read = [{"nk": k, "readers": v} for k, v in cnt.items()]
        except Exception:
            read = []
    read_map = {r.get("nk") or r.get("normalize_title_key") or "": int(r.get("readers") or r.get("count") or 0) for r in read}

    # Build per-title retention
    items: list[dict] = []
    retained = 0
    for nk, wrow in wl_title_norm.items():
        d = disp_map.get(nk, 0)
        r = read_map.get(nk, 0)
        # retention = read_sessions / dispatched (cap 100)
        pct = round(min(100.0, (r / d * 100) if d else (100.0 if r else 0.0)), 1) if (d or r) else 0.0
        if r > 0:
            retained += 1
        items.append({
            "title_key": wrow.get("title_key") or nk,
            "title": wrow.get("title") or nk,
            "dispatched_30d": d,
            "read_sessions": r,
            "retention_pct": pct,
        })
    items.sort(key=lambda x: x["retention_pct"], reverse=True)
    top_retained = [x for x in items if x["retention_pct"] > 0][:10]
    top_churned = [x for x in items if x["retention_pct"] == 0 and x["dispatched_30d"] > 0][:10]
    overall = round((retained / total_wl * 100) if total_wl else 0.0, 1)
    churned = total_wl - retained

    return JSONResponse(content={
        "success": True,
        "data": {
            "overall_retention_30d": overall,
            "total_whitelisted": total_wl,
            "retained_titles": retained,
            "churned_titles": churned,
            "top_retained": top_retained,
            "top_churned": top_churned,
        }
    })


@router.get("/analytics/engagement", response_model=EngagementEnvelope)
async def analytics_engagement(request: Request):
    """User engagement metrics — reading activity, active users."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    from app.db import q

    # Each query isolated — one failing shouldn't 500 the whole endpoint
    def _safe_q(sql: str, fallback: list | None = None):
        try:
            return q(sql)
        except Exception as e:
            logger.warn("analytics_engagement subquery failed", sql=sql[:80], err=str(e)[:160])
            return fallback if fallback is not None else []

    active_sessions = _safe_q("""
        SELECT COUNT(DISTINCT session_hash) as active_users
        FROM continue_reading
        WHERE to_timestamp(updated_at) >= NOW() - INTERVAL '24 hours'
    """)
    total_progress = _safe_q("""
        SELECT COUNT(*) as total_sessions
        FROM continue_reading
    """)
    most_read = _safe_q("""
        SELECT key as title_key, COUNT(*) as reader_count
        FROM continue_reading, jsonb_object_keys(entries) as key
        GROUP BY key
        ORDER BY reader_count DESC
        LIMIT 20
    """)
    activity = _safe_q("""
        SELECT DATE(to_timestamp(updated_at)) as date, COUNT(*) as active_users
        FROM continue_reading
        WHERE to_timestamp(updated_at) >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(to_timestamp(updated_at))
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
