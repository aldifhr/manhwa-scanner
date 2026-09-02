"""Reading stats — track chapter link clicks + reading analytics."""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse, parse_qs, unquote

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:reading_stats")
router = APIRouter()

# In-memory click buffer (flushed to DB periodically)
_click_buffer: list[dict] = []


@router.get("/api/redirect/chapter")
async def redirect_chapter(url: str, request: Request):
    """Redirect to actual chapter URL while tracking the click.
    
    Discord embeds use this URL instead of direct chapter links.
    Tracks: chapter_url, source (from referrer), timestamp, user_agent.
    """
    if not url:
        return Response(content="missing url", status_code=400)
    
    # Decode double-encoded URLs
    target = unquote(url)
    if not target.startswith(("http://", "https://")):
        return Response(content="invalid url", status_code=400)
    
    # Track click (async fire-and-forget)
    try:
        _track_chapter_click(
            chapter_url=target,
            source=_extract_source(target),
            user_agent=request.headers.get("user-agent", ""),
            ip=request.client.host if request.client else "",
            referrer=request.headers.get("referer", ""),
        )
    except Exception as e:
        logger.warn("click track failed", err=str(e)[:100])
    
    return RedirectResponse(url=target, status_code=302)


def _extract_source(url: str) -> str:
    """Extract source name from chapter URL."""
    if "shinigami.asia" in url:
        return "shinigami"
    elif "voratoon.com" in url:
        return "voratoon"
    elif "ikiru.wtf" in url:
        return "ikiru"
    return "unknown"


def _track_chapter_click(chapter_url: str, source: str, user_agent: str, ip: str, referrer: str):
    """Buffer a click event for batch insert."""
    _click_buffer.append({
        "chapter_url": chapter_url,
        "source": source,
        "user_agent": user_agent[:200],
        "ip": ip,
        "referrer": referrer[:200],
        "clicked_at": datetime.now(timezone.utc).isoformat(),
    })
    
    # Flush every 50 clicks
    if len(_click_buffer) >= 50:
        _flush_clicks()


def _flush_clicks():
    """Batch insert buffered clicks to DB."""
    global _click_buffer
    if not _click_buffer:
        return
    clicks = _click_buffer[:]
    _click_buffer = []
    try:
        from app.db import q
        # Use individual inserts (no bulk insert helper)
        for c in clicks:
            q("""INSERT INTO chapter_clicks 
                (chapter_url, source, user_agent, ip, referrer, clicked_at)
                VALUES (%s, %s, %s, %s, %s, %s)""",
              [c["chapter_url"], c["source"], c["user_agent"], c["ip"], c["referrer"], c["clicked_at"]])
    except Exception as e:
        logger.warn("flush clicks failed", err=str(e)[:100], count=len(clicks))


@router.get("/api/reading-stats/overview")
async def reading_stats_overview(request: Request):
    """Reading stats overview — most clicked chapters, peak hours, trends."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.db import q
        
        # Most clicked chapters (last 7 days)
        top_chapters = q("""
            SELECT chapter_url, source, COUNT(*) as clicks,
                   COUNT(DISTINCT ip) as unique_readers
            FROM chapter_clicks
            WHERE clicked_at >= NOW() - INTERVAL '7 days'
            GROUP BY chapter_url, source
            ORDER BY clicks DESC
            LIMIT 20
        """)
        
        # Clicks by source
        by_source = q("""
            SELECT source, COUNT(*) as clicks
            FROM chapter_clicks
            WHERE clicked_at >= NOW() - INTERVAL '7 days'
            GROUP BY source
            ORDER BY clicks DESC
        """)
        
        # Peak hours (UTC)
        peak_hours = q("""
            SELECT EXTRACT(HOUR FROM clicked_at) as hour, COUNT(*) as clicks
            FROM chapter_clicks
            WHERE clicked_at >= NOW() - INTERVAL '7 days'
            GROUP BY EXTRACT(HOUR FROM clicked_at)
            ORDER BY hour
        """)
        
        # Daily trend (last 30 days)
        daily_trend = q("""
            SELECT DATE(clicked_at) as date, COUNT(*) as clicks,
                   COUNT(DISTINCT ip) as unique_readers
            FROM chapter_clicks
            WHERE clicked_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(clicked_at)
            ORDER BY date DESC
        """)
        
        # Total stats
        totals = q("""
            SELECT COUNT(*) as total_clicks,
                   COUNT(DISTINCT ip) as total_readers,
                   COUNT(DISTINCT chapter_url) as unique_chapters
            FROM chapter_clicks
            WHERE clicked_at >= NOW() - INTERVAL '7 days'
        """)
        
        return JSONResponse(content={
            "success": True,
            "data": {
                "top_chapters": top_chapters,
                "by_source": by_source,
                "peak_hours": peak_hours,
                "daily_trend": daily_trend,
                "totals": totals[0] if totals else {},
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
        })
    except Exception as e:
        logger.warn("reading_stats_overview failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/api/reading-stats/series/{title_key}")
async def reading_stats_series(request: Request, title_key: str):
    """Reading stats for a specific series."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        from app.db import q
        
        # Clicks for this series (by matching URL pattern)
        clicks = q("""
            SELECT chapter_url, COUNT(*) as clicks,
                   COUNT(DISTINCT ip) as unique_readers,
                   MAX(clicked_at) as last_clicked
            FROM chapter_clicks
            WHERE clicked_at >= NOW() - INTERVAL '30 days'
              AND (
                chapter_url LIKE %s OR
                chapter_url LIKE %s OR
                chapter_url LIKE %s
              )
            GROUP BY chapter_url
            ORDER BY clicks DESC
        """, [
            f"%/{title_key}/chapter/%",
            f"%/{title_key.replace('-', ' ')}/%",
            f"%{title_key}%",
        ])
        
        return JSONResponse(content={
            "success": True,
            "data": {
                "title_key": title_key,
                "chapter_clicks": clicks,
                "total_clicks": sum(c["clicks"] for c in clicks),
            }
        })
    except Exception as e:
        logger.warn("reading_stats_series failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
