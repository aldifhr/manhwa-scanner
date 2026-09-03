"""RSS feed — simplified architecture.

Data flow: recent_chapters → whitelist (1 join) → response

Before: 6 queries, ~450ms
After:  2 queries, ~100ms
"""
import time as _time
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from app.logger import get_logger
from app.utils.request_auth import int_safe, safe_error, require_monitor_auth
from app.utils.text import normalize_title_key
from app.services.rss_query import (
    build_filter,
    map_result,
    group_results,
)

logger = get_logger("api:rss")
router = APIRouter()

_RSS_CACHE: dict[str, tuple[float, dict]] = {}
_RSS_TTL = 30.0

_rss_new_cache: dict[str, tuple[float, dict]] = {}


def _rss_cache_get(key: str):
    entry = _RSS_CACHE.get(key)
    if entry and (_time.monotonic() - entry[0]) < _RSS_TTL:
        return entry[1]
    return None


def _rss_cache_put(key: str, val: dict):
    _RSS_CACHE[key] = (_time.monotonic(), val)
    if len(_RSS_CACHE) > 200:
        oldest = sorted(_RSS_CACHE.items(), key=lambda kv: kv[1][0])[:50]
        for k, _ in oldest:
            _RSS_CACHE.pop(k, None)


def invalidate_rss_cache(key_prefix: str | None = None):
    """Invalidate RSS cache — per-key if prefix given, else all.

    Excluded whitelist changes affect all RSS keys (filter applied in Python),
    so caller may clear all. If prefix given, only matching keys are removed
    to avoid thundering herd on unrelated queries.
    """
    if key_prefix is None:
        _RSS_CACHE.clear()
    else:
        for k in list(_RSS_CACHE.keys()):
            if k.startswith(key_prefix):
                _RSS_CACHE.pop(k, None)


@router.get("/rss")
async def rss(request: Request):
    # Public read-only feed (used by the manhwa.aldifhr.fun /recent reader page
    # via the FE proxy, which has no session token in serverless). No secrets or
    # writes are exposed here, so auth is intentionally not required.
    # Mutating/operational endpoints (whitelist writes, dispatch, rss/new,
    # rss/health) remain behind require_monitor_auth.
    cache_key = request.url.query
    cached = _rss_cache_get(cache_key)
    if cached is not None:
        try:
            import hashlib as _hl, json as _js
            etag = 'W/"' + _hl.sha256(_js.dumps(cached, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16] + '"'
            if request.headers.get("If-None-Match", "") == etag:
                return Response(status_code=304, headers={"ETag": etag})
            return JSONResponse(content=cached, headers={"ETag": etag})
        except Exception:
            return JSONResponse(content=cached)

    page = int_safe(request.query_params.get("page", "1"), 1)
    try:
        limit = int_safe(request.query_params.get("limit", "500"), 500, max_val=1000)
    except (ValueError, TypeError):
        limit = 500
    if limit > 1000 or limit < 1:
        return JSONResponse(content={"success": False, "error": "limit must be between 1 and 1000"}, status_code=400)
    group = (request.query_params.get("group", "true") or "true").lower() != "false"
    source_f = request.query_params.get("source", "")
    origin_f = request.query_params.get("origin", "")
    exclude = request.query_params.get("exclude", "")
    q = (request.query_params.get("q", "") or "")[:100]
    if len(request.query_params.get("q", "") or "") > 100:
        return JSONResponse(content={"success": False, "error": "q too long (max 100)"}, status_code=400)
    exclude_origin = request.query_params.get("exclude_origin", "")
    type_f = request.query_params.get("type", "")
    # Custom filters (merged from /rss/custom) — handled in Python post-filter for now
    genres_f = request.query_params.get("genres", "")
    status_f = request.query_params.get("status", "")
    min_rating = request.query_params.get("min_rating", "")
    max_rating = request.query_params.get("max_rating", "")
    subscribed_only = request.query_params.get("subscribed_only", "false").lower() == "true"
    sort_f = request.query_params.get("sort", "newest")
    # Reader feed shows ALL recent chapters by default (respects FE "all" feed).
    # Previously defaulted to True, which overrode the FE's "all" request and
    # hid every non-whitelisted title — making /recent look permanently stale.
    whitelist_only = request.query_params.get("whitelist", "false").lower() == "true" or subscribed_only
    # Default: show ALL chapters (including already-notified).
    # RSS is the discovery feed — hiding notified chapters breaks the
    # "see latest → add to whitelist" workflow. The FE marks isSent
    # on each chapter so users can see what's already been dispatched.
    # Use ?exclude_notified=true to hide them (for the "new only" view).
    _excl_raw = request.query_params.get("exclude_notified")
    if _excl_raw is None:
        exclude_notified = False
    else:
        exclude_notified = _excl_raw.lower() == "true"

    try:
        from app.db import get_supabase
        sb = get_supabase()

        # QUERY 1: Fetch recent_chapters + whitelist in one go
        # Whitelist has all metadata: cover, genres, rating, description, series_url
        hours = 24
        from datetime import timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

        rc_q = (
            sb.table("recent_chapters")
            .select(
                "chapter_url, title_key, title, chapter, chapter_num, source, cover, origin, updated_time, created_at, series_url, description, type, rating, genres"
            )
            .gte("updated_time", cutoff)
        )
        # Push filters to the DB (MAN-009): filter at SQL level, not in Python,
        # so a 100k-row table doesn't get fully pulled into memory first.
        if source_f:
            rc_q = rc_q.eq("source", source_f)
        if origin_f:
            rc_q = rc_q.eq("origin", origin_f.upper())
        if exclude_origin:
            _excl_o = [e.strip().upper() for e in exclude_origin.split(",") if e.strip()]
            for o in _excl_o:
                rc_q = rc_q.neq("origin", o)
        if type_f:
            rc_q = rc_q.eq("type", type_f.lower())
        if q:
            _q = q.replace("%", r"\%").replace("_", r"\_")
            rc_q = rc_q.ilike("title", f"%{_q}%")
        # Fetch up to 1000 for consistent total (fix: limit*page made total vary per page)
        _fetch_limit = 1000
        rc_rows = rc_q.order("updated_time", desc=True).limit(_fetch_limit).execute().data or []

        # Exclude chapters already notified (FCFS dispatch_history) so RSS shows
        # only genuinely NEW releases, not backlog re-touched by the scraper
        # with a fresh updated_time. Lo asked: 24h window only, no old backlog.
        # Now opt-in via ?exclude_notified=true (the reader page shows all).
        #
        # PERF-007: previously this pulled the ENTIRE 24h dispatch_history into
        # Python and built a set to filter rc_rows — O(notified) memory + transfer.
        # Now we push the exclusion into the SQL via NOT EXISTS anti-join (DB does
        # the filtering), so only un-notified recent_chapters are transferred.
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
                    _q = q.replace("%", r"\%").replace("_", r"\_")
                    _where.append("rc.title ILIKE %s")
                    _params.append(f"%{_q}%")
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
                _params.append(_fetch_limit)
                rc_rows = _raw_q(_sql, _params) or []
            except Exception as _e:
                logger.warn("exclude_notified SQL failed, falling back to unfiltered", err=str(_e)[:160])

        # Build whitelist lookup (title_key → metadata) + series_meta in parallel
        import asyncio

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
            # Fallback sequential if event loop not available (e.g. sync test)
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
        for w in wl_rows:
            tk = str(w.get("title_key", "") or "")
            src = str(w.get("source", "") or "")
            if tk:
                nk = normalize_title_key(tk)
                wl_map[(nk, src)] = w
                wl_map[(tk, src)] = w

        # Build whitelist metadata lookup for non-whitelisted fallback — parallel chunk fetch
        meta_map: dict[str, dict] = {}
        try:
            slugs = list({ (r.get("series_url") or "").rstrip("/").split("/")[-1] for r in rc_rows if r.get("series_url") })
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

                    results = await asyncio.gather(
                        *[loop.run_in_executor(None, _fetch_one, c) for c in chunks]
                    )
                    out: dict[str, dict] = {}
                    for mrows in results:
                        for m in mrows:
                            out[str(m.get("title_key") or "")] = m
                    return out

                try:
                    meta_map = await _fetch_meta_chunks()
                except Exception:
                    # Fallback sequential if no running loop
                    for chunk in chunks:
                        try:
                            mrows = sb.table("whitelist").select("title_key, cover, status, rating, genres, description, origin").in_("title_key", chunk).execute().data or []
                            for m in mrows:
                                meta_map[str(m.get("title_key") or "")] = m
                        except Exception:
                            continue
        except Exception:
            pass

        # series_meta map from parallel fetch
        sm_map: dict[tuple[str, str], dict] = {}
        for s in sm_rows:
            stk = str(s.get("title_key") or "")
            ssrc = str(s.get("source") or "")
            if stk and ssrc:
                sm_map[(stk, ssrc)] = s

        # Build dispatch_history lookup (title_key, chapter_num) -> sent
        # Source of truth for isSent (BUG3): a chapter is "sent" if it appears
        # in dispatch_history for THAT title+chapter (any source). Dispatch is
        # per-release, not per-source, so we key on (title_key, chapter_num).
        # Filter by cutoff (24h) to avoid full-table scan as history grows.
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
            pass

        # Filter
        _passes = build_filter(source_f, origin_f, exclude, q, exclude_origin, _excl_keys, type_f)
        filtered = [it for it in rc_rows if _passes(it)]

        # Build results
        live_cnt_ref = [0]  # mutable counter for live fetches
        results = [map_result(it, wl_map, meta_map, live_cnt_ref, sm_map, dh_sent) for it in filtered]

        if whitelist_only:
            results = [r for r in results if r["isWhitelisted"]]

        # unread_only from /rss/custom → filter not sent
        unread_only = request.query_params.get("unread_only", "false").lower() == "true"
        if unread_only:
            results = [r for r in results if not r.get("isSent")]

        # Custom filters (merged from /rss/custom) — genres/status/rating/sort
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
        if sort_f == "rating":
            try:
                results.sort(key=lambda x: float(x.get("rating") or 0), reverse=True)
            except Exception:
                pass
        elif sort_f == "popular":
            # popularity via rating as proxy (dispatch_count not in rss map)
            try:
                results.sort(key=lambda x: float(x.get("rating") or 0), reverse=True)
            except Exception:
                pass
        # sources/origins plural (from /rss/custom)
        sources_f = request.query_params.get("sources", "")
        if sources_f:
            try:
                wanted_src = {s.strip().lower() for s in sources_f.split(",") if s.strip()}
                if wanted_src:
                    results = [r for r in results if str(r.get("source") or "").lower() in wanted_src]
            except Exception:
                pass
        origins_f = request.query_params.get("origins", "")
        if origins_f:
            try:
                wanted_o = {o.strip().upper() for o in origins_f.split(",") if o.strip()}
                if wanted_o:
                    results = [r for r in results if str(r.get("origin") or "").upper() in wanted_o]
            except Exception:
                pass

        # BUG1: dedupe flat mode by (canonicalTitleKey, chapterNumber).
        # Cross-source duplicates (same chapter scraped from ikiru + voratoon,
        # or voratoon + shinigami) collapse to ONE row; sources[] aggregates.
        if not group:
            _seen: dict[tuple[str, float], dict] = {}
            _deduped: list[dict] = []
            for r in results:
                ctk = r.get("canonicalTitleKey") or ""
                cn = r.get("chapterNumber")
                if cn is None:
                    _deduped.append(r)
                    continue
                key = (ctk, float(cn))
                if key in _seen:
                    # merge source into existing row's sources[]
                    _existing = _seen[key]
                    for s in (r.get("sources") or []):
                        if s not in _existing.get("sources", []):
                            _existing.setdefault("sources", []).append(s)
                    if not _existing.get("source"):
                        _existing["source"] = r.get("source")
                else:
                    _seen[key] = r
                    _deduped.append(r)
            results = _deduped

        if group:
            final_results = group_results(results)
        else:
            final_results = results

        total = len(final_results)
        total_pages = (total + limit - 1) // limit if limit else 1
        start = (page - 1) * limit
        paged = final_results[start:start + limit]

        body = {
            "success": True,
            "data": {
                "results": paged,
                "total": total,
                "page": page,
                "pageSize": limit,
                "limit": limit,
                "totalPages": total_pages,
                "hasMore": page * limit < total,
                "has_more": page * limit < total,
            },
        }
        _rss_cache_put(cache_key, body)
        return JSONResponse(content=body, headers={"Cache-Control": "no-store, max-age=0"})

    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.get("/rss/new")
async def rss_new(request: Request):
    """Lightweight new-items counter."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    raw = (request.query_params.get("since", "") or "").strip()
    if not raw:
        return JSONResponse(content={"success": False, "error": "missing since"}, status_code=400)
    since = raw
    try:
        val = float(raw)
        if val > 1e12:
            val = val / 1000.0
        since = datetime.fromtimestamp(val, tz=timezone.utc).isoformat()
    except Exception:
        pass

    distinct = request.query_params.get("distinct", "all")
    cache_key = f"{since}_{distinct}"
    _now = _time.monotonic()
    if cache_key in _rss_new_cache:
        _cache_ts, _cache_val = _rss_new_cache[cache_key]
        if _now - _cache_ts < 30.0:
            resp = JSONResponse(content=_cache_val)
            resp.headers["X-Cache"] = "HIT"
            return resp

    try:
        from app.db import q
        if distinct == "title":
            sql = "SELECT COUNT(DISTINCT title_key) as cnt, MAX(updated_time) as latest FROM recent_chapters WHERE updated_time >= %s"
        else:
            sql = "SELECT COUNT(*) as cnt, MAX(updated_time) as latest FROM recent_chapters WHERE updated_time >= %s"
        result = q(sql, [since])
        count = result[0]["cnt"] if result else 0
        latest = result[0]["latest"] if result else since
        payload = {"success": True, "data": {"since": since, "newCount": count, "latestUpdatedTime": latest}}
        _rss_new_cache[cache_key] = (_now, payload)
        if len(_rss_new_cache) > 500:
            _cutoff = _now - 60.0
            for k in [k for k, v in _rss_new_cache.items() if v[0] < _cutoff]:
                _rss_new_cache.pop(k, None)
        resp = JSONResponse(content=payload)
        resp.headers["X-Cache"] = "MISS"
        return resp
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.get("/rss/health")
async def rss_health(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.storage import health as health_store
    from app.config import settings as _settings
    sources = health_store.load_source_health_map(_settings.SOURCE_KEYS)
    return JSONResponse(content={"success": True, "data": {"sources": sources}})
