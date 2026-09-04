"""Release activity heatmap data.

GET /api/activity/heatmap?weeks=26
-> { "days": [{"date": "2026-08-24", "count": 14}, ...], "total": 812, "peak": {"date": "...", "count": N} }

Counts distinct chapters scraped per day (recent_chapters.updated_time).
Public-read like /api/rss — no secrets exposed, only aggregate counts.

DB access uses the shared pool (app.db_adapter.get_conn) and runs in a worker
thread (asyncio.to_thread) so the single uvicorn event loop isn't blocked on
a synchronous psycopg2 round-trip.
"""
from __future__ import annotations

import asyncio
from datetime import date, timedelta

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import int_safe

logger = get_logger("api:activity")
router = APIRouter()


def _counts_by_day(days: int) -> dict[str, int]:
    from app.db_adapter import get_conn, put_conn
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT to_char(date_trunc('day', updated_time), 'YYYY-MM-DD') AS d,
                   COUNT(DISTINCT chapter_url) AS c
            FROM recent_chapters
            WHERE updated_time >= now() - (%s || ' days')::interval
            GROUP BY 1 ORDER BY 1
            """,
            (days,),
        )
        return {row["d"]: int(row["c"]) for row in cur.fetchall()}
    finally:
        put_conn(conn)


@router.get("/activity/heatmap")
async def activity_heatmap(request: Request):
    try:
        weeks = min(max(int_safe(request.query_params.get("weeks"), default=26, max_val=52), 1), 52)
        days_n = weeks * 7
        counts = await asyncio.to_thread(_counts_by_day, days_n)
        today = date.today()
        start = today - timedelta(days=days_n - 1)

        out_days = []
        total = 0
        peak_date, peak_count = None, 0
        d = start
        while d <= today:
            key = d.isoformat()
            c = counts.get(key, 0)
            total += c
            if c > peak_count:
                peak_date, peak_count = key, c
            out_days.append({"date": key, "count": c})
            d += timedelta(days=1)

        return JSONResponse(content={
            "success": True,
            "data": {
                "weeks": weeks,
                "days": out_days,
                "total": total,
                "peak": {"date": peak_date, "count": peak_count} if peak_date else None,
            },
        })
    except Exception as e:
        logger.warn("heatmap failed", err=str(e)[:160])
        return JSONResponse(content={"success": False, "error": "internal server error"}, status_code=500)
