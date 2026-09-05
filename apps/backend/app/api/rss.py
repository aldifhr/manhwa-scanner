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
    # P1 cache-share: if cron just wrote new chapters, bust local RSS cache (Redis shared flag)
    try:
        from app.tasks import _get_redis as _gr2
        if _gr2().get("rss:invalidate"):
            _RSS_CACHE.clear()
            _gr2().delete("rss:invalidate")
    except Exception:
        pass
    return await _rss_impl(request)


@router.get("/reader/rss")
async def rss_reader(request: Request):
    """Alias for FE compatibility — /api/v1/reader/rss → /api/v1/rss."""
    return await _rss_impl(request)


async def _rss_impl(request: Request):
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
    # Default: exclude Japanese manga unless user explicitly requests JP or sets exclude_origin
    if not origin_f and not exclude_origin:
        exclude_origin = "JP"
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
        from app.services.rss_service import fetch_rss_data
        hours = 24
        from datetime import timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        _fetch_limit = min(1000, max(200, limit * page * 3 + 20)) if limit <= 100 else 1000
        results, wl_map, meta_map, sm_map, dh_sent = await fetch_rss_data(
            cutoff=cutoff,
            source_f=source_f,
            origin_f=origin_f,
            exclude=exclude,
            q=q,
            exclude_origin=exclude_origin,
            type_f=type_f,
            genres_f=genres_f,
            status_f=status_f,
            min_rating=min_rating,
            max_rating=max_rating,
            subscribed_only=subscribed_only,
            sort_f=sort_f,
            limit=limit,
            page=page,
            whitelist_only=whitelist_only,
            exclude_notified=exclude_notified,
            fetch_limit=_fetch_limit,
        )
        # unread_only extra (not in service)
        unread_only = request.query_params.get("unread_only", "false").lower() == "true"
        if unread_only:
            results = [r for r in results if not r.get("isSent")]

        # genres/status/rating already filtered in fetch_rss_data — skip duplicate pass
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
        # hasMore heuristic: if we fetched max and filtered still fills page, DB likely has more beyond fetch
        _has_more = page * limit < total
        if not _has_more and len(rc_rows) == _fetch_limit and len(filtered) >= limit:
            _has_more = True
            # total underestimate when fetch truncated — bump for UI hasMore
            total = max(total, page * limit + 1)
            total_pages = (total + limit - 1) // limit if limit else 1

        body = {
            "success": True,
            "data": {
                "results": paged,
                "total": total,
                "page": page,
                "pageSize": limit,
                "limit": limit,
                "totalPages": total_pages,
                "hasMore": _has_more,
                "has_more": _has_more,
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
