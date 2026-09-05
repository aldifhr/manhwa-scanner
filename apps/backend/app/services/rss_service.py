"""RSS service — extracted from app/api/rss.py for testability.

Single seam for DB fetch + whitelist/series_meta joins + isSent + filtering.
rss.py now only handles HTTP (cache, pagination, dedup/group).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta

from app.logger import get_logger
from app.utils.text import normalize_title_key
from app.services.rss_query import build_filter, map_result, group_results

logger = get_logger("services:rss_service")


async def fetch_rss_data(
    *,
    cutoff: str,
    source_f: str = "",
    origin_f: str = "",
    exclude: str = "",
    q: str = "",
    exclude_origin: str = "",
    type_f: str = "",
    genres_f: str = "",
    status_f: str = "",
    min_rating: str = "",
    max_rating: str = "",
    subscribed_only: bool = False,
    sort_f: str = "newest",
    limit: int = 500,
    page: int = 1,
    whitelist_only: bool = False,
    exclude_notified: bool = False,
    fetch_limit: int = 1000,
):
    """Fetch recent_chapters + lookups and return mapped results."""
    from app.db import get_supabase

    sb = get_supabase()

    # Recent chapters
    rc_q = (
        sb.table("recent_chapters")
        .select(
            "chapter_url, title_key, title, chapter, chapter_num, source, cover, origin, updated_time, created_at, series_url, description, type, rating, genres"
        )
        .gte("updated_time", cutoff)
    )
    if source_f:
        rc_q = rc_q.eq("source", source_f)
    if origin_f:
        rc_q = rc_q.eq("origin", origin_f.upper())
    if exclude_origin:
        excl_o = [e.strip().upper() for e in exclude_origin.split(",") if e.strip()]
        for o in excl_o:
            rc_q = rc_q.neq("origin", o)
    if type_f:
        rc_q = rc_q.eq("type", type_f.lower())
    if q:
        _q = q.replace("%", r"\%").replace("_", r"\_")
        rc_q = rc_q.ilike("title", f"%{_q}%")
    rc_rows = rc_q.order("updated_time", desc=True).limit(fetch_limit).execute().data or []

    if exclude_notified:
        try:
            from app.db import q as _raw_q

            _where = ["rc.updated_time >= %s"]
            _params: list = [cutoff]
            if source_f:
                _where.append("rc.source = %s")
                _params.append(source_f)
            if origin_f:
                _where.append("rc.origin = %s")
                _params.append(origin_f.upper())
            if exclude_origin:
                for _o in [e.strip().upper() for e in exclude_origin.split(",") if e.strip()]:
                    _where.append("rc.origin != %s")
                    _params.append(_o)
            if type_f:
                _where.append("rc.type = %s")
                _params.append(type_f.lower())
            if q:
                _q2 = q.replace("%", r"\%").replace("_", r"\_")
                _where.append("rc.title ILIKE %s")
                _params.append(f"%{_q2}%")
            _where.append(
                "NOT EXISTS (SELECT 1 FROM dispatch_history dh "
                "WHERE dh.title_key = rc.title_key AND dh.source = rc.source "
                "AND dh.chapter_title ~ '^[0-9]+(\\.[0-9]+)?$' "
                "AND dh.chapter_title::float = rc.chapter_num AND dh.sent_at >= %s)"
            )
            _params.append(cutoff)
            _sql = (
                "SELECT chapter_url, title_key, title, chapter, chapter_num, source, "
                "cover, origin, updated_time, created_at, series_url, description, type "
                f"FROM recent_chapters rc WHERE {' AND '.join(_where)} "
                "ORDER BY rc.updated_time DESC LIMIT %s"
            )
            _params.append(fetch_limit)
            rc_rows = _raw_q(_sql, _params) or []
        except Exception as _e:
            logger.warn("exclude_notified SQL failed, falling back to unfiltered", err=str(_e)[:160])

    # Parallel whitelist + series_meta
    async def _fetch_wl_and_sm():
        loop = asyncio.get_running_loop()

        def _fetch_wl():
            try:
                return sb.table("whitelist").select(
                    "title_key, source, cover, genres, rating, description, series_url, origin, status, type, latest_sent_chapter"
                ).execute().data or []
            except Exception:
                return []

        def _fetch_sm():
            try:
                return sb.table("series_meta").select(
                    "title_key, source, rating, genres, description, cover, type"
                ).execute().data or []
            except Exception:
                return []

        wl_rows, sm_rows = await asyncio.gather(
            loop.run_in_executor(None, _fetch_wl),
            loop.run_in_executor(None, _fetch_sm),
        )
        return wl_rows, sm_rows

    try:
        wl_rows, sm_rows = await _fetch_wl_and_sm()
    except Exception:
        try:
            wl_rows = sb.table("whitelist").select(
                "title_key, source, cover, genres, rating, description, series_url, origin, status, type, latest_sent_chapter"
            ).execute().data or []
        except Exception:
            wl_rows = []
        try:
            sm_rows = sb.table("series_meta").select(
                "title_key, source, rating, genres, description, cover, type"
            ).execute().data or []
        except Exception:
            sm_rows = []

    wl_map: dict[tuple[str, str], dict] = {}
    wl_title_set: set[str] = set()
    for w in wl_rows:
        tk = str(w.get("title_key", "") or "")
        src = str(w.get("source", "") or "")
        if tk:
            nk = normalize_title_key(tk)
            wl_map[(nk, src)] = w
            wl_map[(tk, src)] = w
        # Title-based set for cross-source UUID vs slug matching (Full-time Hunter)
        t_norm = normalize_title_key(w.get("title") or tk)
        if t_norm:
            wl_title_set.add(t_norm)

    # meta_map parallel chunks
    meta_map: dict[str, dict] = {}
    try:
        slugs = list({(r.get("series_url") or "").rstrip("/").split("/")[-1] for r in rc_rows if r.get("series_url")})
        slugs = [s for s in slugs if s]
        if slugs:
            chunks = [slugs[i:i+100] for i in range(0, len(slugs), 100)]

            async def _fetch_meta_chunks():
                loop = asyncio.get_running_loop()

                def _fetch_one(chunk):
                    try:
                        return sb.table("whitelist").select("title_key, cover, status, rating, genres, description, origin").in_("title_key", chunk).execute().data or []
                    except Exception:
                        return []

                results = await asyncio.gather(*[loop.run_in_executor(None, _fetch_one, c) for c in chunks])
                out: dict[str, dict] = {}
                for mrows in results:
                    for m in mrows:
                        out[str(m.get("title_key") or "")] = m
                return out

            try:
                meta_map = await _fetch_meta_chunks()
            except Exception:
                for chunk in chunks:
                    try:
                        mrows = sb.table("whitelist").select("title_key, cover, status, rating, genres, description, origin").in_("title_key", chunk).execute().data or []
                        for m in mrows:
                            meta_map[str(m.get("title_key") or "")] = m
                    except Exception:
                        continue
    except Exception:
        pass

    sm_map: dict[tuple[str, str], dict] = {}
    for s in sm_rows:
        stk = str(s.get("title_key") or "")
        ssrc = str(s.get("source") or "")
        if stk and ssrc:
            sm_map[(stk, ssrc)] = s

    # dispatch_history for isSent
    dh_sent: set[tuple[str, float]] = set()
    try:
        dh_rows = sb.table("dispatch_history").select("title_key, source, chapter_title").gte("sent_at", cutoff).limit(2000).execute().data or []
        for dh in dh_rows:
            tk = str(dh.get("title_key") or "")
            ct = dh.get("chapter_title")
            try:
                cn = float(ct) if ct is not None else None
            except (ValueError, TypeError):
                cn = None
            if tk and cn is not None:
                dh_sent.add((tk, cn))
                nk = normalize_title_key(tk)
                if nk != tk:
                    dh_sent.add((nk, cn))
    except Exception:
        pass

    try:
        from app.storage import excluded_titles as _excl_store

        _excl_keys = _excl_store.load_excluded_keys()
    except Exception:
        _excl_keys = set()

    _passes = build_filter(source_f, origin_f, exclude, q, exclude_origin, _excl_keys, type_f)
    filtered = [it for it in rc_rows if _passes(it)]

    live_cnt_ref = [0]
    results = [map_result(it, wl_map, meta_map, live_cnt_ref, sm_map, dh_sent, wl_title_set) for it in filtered]

    if whitelist_only or subscribed_only:
        results = [r for r in results if r["isWhitelisted"]]

    # Custom filters
    if genres_f:
        try:
            wanted = {g.strip().lower() for g in genres_f.split(",") if g.strip()}
            if wanted:
                results = [r for r in results if wanted & {str(g).lower() for g in (r.get("genres") or [])}]
        except Exception:
            pass
    if status_f:
        try:
            sf = status_f.strip().lower()
            results = [r for r in results if str(r.get("status") or r.get("whitelistStatus") or "").lower() == sf]
        except Exception:
            pass
    if min_rating:
        try:
            mv = float(min_rating)
            results = [r for r in results if r.get("rating") is not None and float(r.get("rating") or 0) >= mv]
        except Exception:
            pass
    if max_rating:
        try:
            mv = float(max_rating)
            results = [r for r in results if r.get("rating") is not None and float(r.get("rating") or 0) <= mv]
        except Exception:
            pass
    return results, wl_map, meta_map, sm_map, dh_sent
