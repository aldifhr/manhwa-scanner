"""RSS filters metadata — genres/sources for FilterDrawer."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:rss_custom")
router = APIRouter()


@router.get("/rss/filters/metadata")
async def rss_filter_metadata(request: Request):
    """Get available filter options for the custom RSS feed.
    
    Returns all available genres, sources, origins, and statuses
    that can be used to filter the feed.
    """
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        from app.db import q

        # All unique genres
        genres = q("""
            SELECT DISTINCT jsonb_array_elements_text(genres) as genre
            FROM series_meta
            WHERE genres IS NOT NULL AND genres != '[]'::jsonb
            ORDER BY genre
        """)

        # All sources
        sources = q("""
            SELECT DISTINCT source FROM recent_chapters WHERE source IS NOT NULL ORDER BY source
        """)

        # All origins
        origins = q("""
            SELECT DISTINCT origin FROM recent_chapters WHERE origin IS NOT NULL AND origin != '' ORDER BY origin
        """)

        # Whitelist statuses
        statuses = q("""
            SELECT DISTINCT status FROM whitelist WHERE status IS NOT NULL AND status != '' ORDER BY status
        """)

        return JSONResponse(content={
            "success": True,
            "data": {
                "genres": [g["genre"] for g in genres],
                "sources": [s["source"] for s in sources],
                "origins": [o["origin"] for o in origins],
                "statuses": [s["status"] for s in statuses],
            }
        })
    except Exception as e:
        logger.warn("rss_filter_metadata failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)
