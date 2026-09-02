"""Whitelist repo — DB pagination + raw fetch.

Thin data-access layer so whitelist_service doesn't embed builder logic.
Keeps the 2 fetch modes (merge vs paginated) in one place.
"""
from __future__ import annotations

from app.logger import get_logger

logger = get_logger("services:whitelist_repo")


def fetch_whitelist_rows(
    source: str = "",
    title: str = "",
    page: int = 1,
    page_size: int = 100,
    merge: bool = True,
):
    """Fetch whitelist rows DB-side when filters present.

    Returns (rows, total, sb_client, is_paginated_flag).
    Falls back to in-memory load on DB failure.
    """
    from app.db import get_supabase
    from app.storage import whitelist as wl_store

    try:
        page = max(1, int(page))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = max(1, min(10000, int(page_size)))
    except (TypeError, ValueError):
        page_size = 100

    use_db_pagination = bool(source or title)
    if use_db_pagination:
        try:
            sb_pg = get_supabase()
            q = sb_pg.table("whitelist").select("*", count="exact")
            if source:
                q = q.eq("source", source)
            if title:
                _t = title.replace("%", r"\%").replace("_", r"\_")
                q = q.ilike("title", f"%{_t}%")
            cnt_res = q.limit(1).execute()
            total_raw = cnt_res.count or 0
            if merge:
                q2 = sb_pg.table("whitelist").select("*")
                if source:
                    q2 = q2.eq("source", source)
                if title:
                    _t2 = title.replace("%", r"\%").replace("_", r"\_")
                    q2 = q2.ilike("title", f"%{_t2}%")
                q2 = q2.order("created_at", desc=True).limit(10000)
                rows = q2.execute().data or []
                return rows, total_raw, sb_pg, False
            else:
                start = (page - 1) * page_size
                q2 = sb_pg.table("whitelist").select("*")
                if source:
                    q2 = q2.eq("source", source)
                if title:
                    _t2 = title.replace("%", r"\%").replace("_", r"\_")
                    q2 = q2.ilike("title", f"%{_t2}%")
                q2 = q2.order("created_at", desc=True).limit(page_size).offset(start)
                rows = q2.execute().data or []
                return rows, total_raw, sb_pg, True
        except Exception as e:
            logger.warn("whitelist_repo DB pagination failed, fallback in-memory", err=str(e)[:160])
    # Fallback / no-filter path
    rows = wl_store.load_whitelist()
    if source:
        rows = [r for r in rows if (r.get("source") or "") == source]
    if title:
        _ql = title.lower()
        rows = [r for r in rows if _ql in (r.get("title", "") or "").lower()]
    from app.db import get_supabase
    sb = get_supabase()
    return rows, len(rows), sb, False
