"""RSS feed — custom filters per user preference."""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:rss_custom")
router = APIRouter()


@router.get("/rss/custom")
async def rss_custom_feed(request: Request):
    """Custom RSS feed with advanced filters.
    
    Query params:
    - genres: comma-separated genre filter (e.g., "Action,Fantasy")
    - sources: comma-separated source filter (e.g., "ikiru,shinigami")
    - origins: comma-separated origin filter (e.g., "KR,JP")
    - status: whitelist status filter (e.g., "ongoing")
    - min_rating: minimum rating filter (e.g., "7.0")
    - max_rating: maximum rating filter (e.g., "10.0")
    - unread_only: show only unread chapters (requires auth)
    - subscribed_only: show only whitelisted series
    - sort: sort order — "newest" (default), "popular", "rating"
    - limit: items per page (default 50, max 500)
    - page: page number (default 1)
    """
    # Auth required for personalized feeds
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        from app.db import q, get_supabase
        sb = get_supabase()

        # Parse filters
        genres_filter = request.query_params.get("genres", "")
        sources_filter = request.query_params.get("sources", "")
        origins_filter = request.query_params.get("origins", "")
        status_filter = request.query_params.get("status", "")
        min_rating = request.query_params.get("min_rating", "")
        max_rating = request.query_params.get("max_rating", "")
        unread_only = request.query_params.get("unread_only", "false").lower() == "true"
        subscribed_only = request.query_params.get("subscribed_only", "false").lower() == "true"
        sort_order = request.query_params.get("sort", "newest")
        limit = min(int(request.query_params.get("limit", 50)), 500)
        page = max(int(request.query_params.get("page", 1)), 1)

        # Build query dynamically
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        conditions = ["rc.updated_time >= %s"]
        params: list = [cutoff]

        # Source filter
        if sources_filter:
            sources = [s.strip() for s in sources_filter.split(",") if s.strip()]
            if sources:
                placeholders = ", ".join(["%s"] * len(sources))
                conditions.append(f"rc.source IN ({placeholders})")
                params.extend(sources)

        # Origin filter
        if origins_filter:
            origins = [o.strip().upper() for o in origins_filter.split(",") if o.strip()]
            if origins:
                placeholders = ", ".join(["%s"] * len(origins))
                conditions.append(f"rc.origin IN ({placeholders})")
                params.extend(origins)

        # Whitelist status filter
        if status_filter:
            conditions.append("w.status = %s")
            params.append(status_filter)

        # Rating filter
        if min_rating:
            conditions.append("COALESCE(sm.rating, w.rating::float, 0) >= %s")
            params.append(float(min_rating))
        if max_rating:
            conditions.append("COALESCE(sm.rating, w.rating::float, 10) <= %s")
            params.append(float(max_rating))

        # Subscribed only (whitelisted)
        if subscribed_only:
            join_whitelist = "INNER JOIN whitelist w ON w.title_key = rc.title_key AND w.source = rc.source"
        else:
            join_whitelist = "LEFT JOIN whitelist w ON w.title_key = rc.title_key AND w.source = rc.source"

        # Genre filter (from series_meta or whitelist)
        genre_condition = ""
        if genres_filter:
            genres = [g.strip() for g in genres_filter.split(",") if g.strip()]
            if genres:
                # Check if any of the requested genres exist in the series' genres
                genre_placeholders = ", ".join(["%s"] * len(genres))
                genre_condition = f"AND (EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sm.genres, w.genres, '[]'::jsonb)) AS g WHERE g IN ({genre_placeholders})))"
                params.extend(genres)

        # Sort order
        sort_map = {
            "newest": "rc.updated_time DESC",
            "popular": "dispatch_count DESC NULLS LAST",
            "rating": "COALESCE(sm.rating, w.rating::float, 0) DESC",
        }
        order_by = sort_map.get(sort_order, "rc.updated_time DESC")

        # Count total first
        count_sql = f"""
            SELECT COUNT(*) as total
            FROM recent_chapters rc
            {join_whitelist}
            LEFT JOIN series_meta sm ON sm.title_key = rc.title_key AND sm.source = rc.source
            WHERE {" AND ".join(conditions)}
            {genre_condition}
        """
        count_result = q(count_sql, params)
        total = count_result[0]["total"] if count_result else 0

        # Fetch paginated results
        offset = (page - 1) * limit
        fetch_sql = f"""
            SELECT 
                rc.chapter_url, rc.title_key, rc.title, rc.chapter, rc.chapter_num,
                rc.source, rc.cover, rc.origin, rc.updated_time, rc.series_url,
                w.title_key as wl_title_key,
                w.status as wl_status,
                w.latest_sent_chapter,
                sm.rating, sm.genres, sm.description, sm.cover as sm_cover,
                (SELECT COUNT(*) FROM dispatch_history dh WHERE dh.title_key = rc.title_key AND dh.source = rc.source) as dispatch_count
            FROM recent_chapters rc
            {join_whitelist}
            LEFT JOIN series_meta sm ON sm.title_key = rc.title_key AND sm.source = rc.source
            WHERE {" AND ".join(conditions)}
            {genre_condition}
            ORDER BY {order_by}
            LIMIT %s OFFSET %s
        """
        params.extend([limit, offset])
        rows = q(fetch_sql, params)

        # Format results
        results = []
        for r in rows:
            results.append({
                "titleKey": r.get("title_key"),
                "title": r.get("title"),
                "chapter": r.get("chapter"),
                "chapterNumber": r.get("chapter_num"),
                "chapterUrl": r.get("chapter_url"),
                "source": r.get("source"),
                "cover": r.get("cover") or r.get("sm_cover"),
                "origin": r.get("origin"),
                "seriesUrl": r.get("series_url"),
                "rating": r.get("rating"),
                "genres": r.get("genres", []),
                "description": r.get("description", ""),
                "isWhitelisted": r.get("wl_title_key") is not None,
                "whitelistStatus": r.get("wl_status"),
                "latestSentChapter": r.get("latest_sent_chapter"),
                "dispatchCount": r.get("dispatch_count", 0),
                "updatedTime": r.get("updated_time"),
            })

        return JSONResponse(content={
            "success": True,
            "data": {
                "results": results,
                "total": total,
                "page": page,
                "pageSize": limit,
                "totalPages": (total + limit - 1) // limit if limit else 1,
                "hasMore": page * limit < total,
                "filters": {
                    "genres": genres_filter,
                    "sources": sources_filter,
                    "origins": origins_filter,
                    "status": status_filter,
                    "minRating": min_rating,
                    "maxRating": max_rating,
                    "sort": sort_order,
                }
            }
        })
    except Exception as e:
        logger.warn("rss_custom_feed failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


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
