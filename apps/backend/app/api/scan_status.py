"""Scan-status endpoint — recent changes with filters.

GET /api/v1/scan-status?hours=24&status=new&source=ikiru&limit=50&offset=0
-> { "success": true, "data": { "items": [...], "total": 42 } }

Filters:
  hours:   lookback window (default 24, max 168)
  status:  'new' | 'updated' | 'unchanged' | comma-list
  source:  exact source name
  limit:   page size (default 50, max 200)
  offset:  pagination offset
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import int_safe, require_monitor_auth

logger = get_logger("api:scan_status")
router = APIRouter()


@router.get("/scan-status")
async def scan_status(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    hours = min(max(int_safe(request.query_params.get("hours"), default=24, max_val=168), 1), 168)
    status_filter = (request.query_params.get("status") or "").strip().lower()
    source = (request.query_params.get("source") or "").strip() or None
    limit = min(max(int_safe(request.query_params.get("limit"), default=50, max_val=200), 1), 200)
    offset = max(int_safe(request.query_params.get("offset"), default=0), 0)

    try:
        from datetime import datetime, timezone, timedelta
        from app.db import q

        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

        conditions = ["updated_time >= %s"]
        params: list = [cutoff]

        statuses = []
        if status_filter:
            statuses = [s.strip() for s in status_filter.split(",") if s.strip()]
            if statuses:
                placeholders = ",".join(["%s"] * len(statuses))
                conditions.append(f"scan_status IN ({placeholders})")
                params.extend(statuses)

        if source:
            conditions.append("source = %s")
            params.append(source)

        where = " AND ".join(conditions)

        total = q(f"SELECT COUNT(*) AS c FROM recent_chapters WHERE {where}", params)
        total_count = int(total[0]["c"]) if total else 0

        rows = q(
            f"""
            SELECT id, title_key, title, chapter, chapter_num, source, cover,
                   series_url, origin, updated_time, scan_status, scan_reason,
                   confidence_score
            FROM recent_chapters
            WHERE {where}
            ORDER BY updated_time DESC
            LIMIT %s OFFSET %s
            """,
            params + [limit, offset],
        )

        items = []
        for r in rows:
            items.append({
                "id": r.get("id"),
                "title_key": r.get("title_key", ""),
                "title": r.get("title", ""),
                "chapter": str(r.get("chapter") or ""),
                "chapter_num": r.get("chapter_num") or 0,
                "source": r.get("source", ""),
                "cover": r.get("cover") or "",
                "series_url": r.get("series_url") or "",
                "origin": r.get("origin") or "",
                "updated_time": r.get("updated_time") or "",
                "scan_status": r.get("scan_status") or "",
                "scan_reason": r.get("scan_reason") or "",
                "confidence_score": r.get("confidence_score") or 0,
            })

        return JSONResponse(content={
            "success": True,
            "data": {
                "items": items,
                "total": total_count,
                "limit": limit,
                "offset": offset,
            },
        })
    except Exception as e:
        logger.warn("scan_status failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal server error"}, status_code=500)
