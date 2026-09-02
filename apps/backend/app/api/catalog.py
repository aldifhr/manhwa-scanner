"""Catalog API (formerly part of the compat layer).

Exposes the Node-backend-shaped catalog endpoints that fe-ag expects.
"""
import re
import urllib.parse as _up
import time as _qtime
from collections import OrderedDict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.utils.text import slugify_title_key, deslugify_title_key, normalize_title_key
from app.logger import get_logger
from app.storage import whitelist as wl_store
from app.utils.request_auth import int_safe, safe_error, require_monitor_auth
from app.utils.cover_scrub import scrub_cover, cover_ref

# Cache for catalog/chapters keyed by title_key (60s TTL).
_CAT_CH_CACHE: list = [0.0, None, None]  # [ts, title_key, payload]
_CAT_CH_TTL = 60.0

logger = get_logger("api:catalog")
router = APIRouter()

# Hard cap on /catalog?all=true so a large table (50k+ titles) can't exhaust
# memory or produce a giant HTTP body in a single unauthenticated-but-monitor
# request. Pagination (default 20, max via page_size) is the safe path.
_MAX_CATALOG_EXPORT = 1000


@router.get("/catalog")
async def catalog_list(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    page = int_safe(request.query_params.get("page", "1"), 1)
    page_size = int_safe(request.query_params.get("page_size", "20"), 20, max_val=_MAX_CATALOG_EXPORT)
    search = request.query_params.get("search", "") or request.query_params.get("q", "")
    source = request.query_params.get("source", "")
    title = request.query_params.get("title", "")
    type_f = request.query_params.get("type", "").strip().lower()
    origin_f = request.query_params.get("origin", "").strip().upper()
    all_param = request.query_params.get("all") == "true"

    from app.db import get_supabase

    # Push filters to DB instead of loading full whitelist in Python (was O(n) full-scan + N+1 cover_ref).
    # Use count+pagination at DB level; fallback to Python only if DB fails.
    try:
        sb = get_supabase()
        q = sb.table("whitelist").select("*", count="exact")
        if source:
            q = q.eq("source", source)
        if type_f:
            q = q.eq("type", type_f)
        if origin_f:
            q = q.eq("origin", origin_f)
        if search:
            # ilike with escaping % and _ to avoid wildcard injection
            _s = search.replace("%", r"\%").replace("_", r"\_")
            q = q.ilike("title", f"%{_s}%")
        if title:
            _t = title.replace("%", r"\%").replace("_", r"\_")
            q = q.ilike("title", f"%{_t}%")
        if all_param:
            # all=true: fetch all matching, but cap to a hard maximum so a
            # 50k-row table can't exhaust Python memory / produce a giant HTTP
            # body in one request. Callers needing the full catalog should page
            # or use a dedicated export endpoint.
            res = q.order("created_at", desc=True).limit(_MAX_CATALOG_EXPORT).execute()
            rows = res.data or []
            total = len(rows)
            paged = rows
            total_pages = 1
            page = 1
            page_size = total or 1
        else:
            # Normal paginated: need total count and page slice from DB
            # First get total via count, then paginated rows
            cnt_res = q.limit(1).execute()
            total = cnt_res.count or 0
            start = (page - 1) * page_size
            # Re-build q for data fetch (count query consumed the builder, need fresh)
            q2 = sb.table("whitelist").select("*")
            if source:
                q2 = q2.eq("source", source)
            if type_f:
                q2 = q2.eq("type", type_f)
            if origin_f:
                q2 = q2.eq("origin", origin_f)
            if search:
                _s = search.replace("%", r"\%").replace("_", r"\_")
                q2 = q2.ilike("title", f"%{_s}%")
            if title:
                _t = title.replace("%", r"\%").replace("_", r"\_")
                q2 = q2.ilike("title", f"%{_t}%")
            paged_res = q2.order("created_at", desc=True).limit(page_size).offset(start).execute()
            paged = paged_res.data or []
            rows = paged  # for total_pages calc below, but total already from count
            total_pages = (total + page_size - 1) // page_size if page_size else 1
    except Exception:
        # Fallback to old in-memory path if DB fails (keeps endpoint alive)
        rows = wl_store.load_whitelist()
        if source:
            rows = [r for r in rows if r.get("source") == source]
        if search:
            sq = search.lower()
            rows = [r for r in rows if sq in (r.get("title", "") or "").lower()]
        if title:
            tq = title.lower()
            rows = [r for r in rows if tq in (r.get("title", "") or "").lower()]
        total = len(rows)
        if all_param:
            page_size = total or 1
            page = 1
            start = 0
            end = total
        else:
            start = (page - 1) * page_size
            end = start + page_size
        paged = rows[start:end]
        total_pages = (total + page_size - 1) // page_size if page_size else 1

    meta_rows = {}
    latest_rows: dict[str, dict] = {}
    if paged:
        tks = [r.get("title_key", "") for r in paged if r.get("title_key")]
        if tks:
            from app.storage import metadata as meta_store
            mrows = meta_store.batch_get_manga_metadata(tks)
            for tk, m in zip(tks, mrows):
                if m:
                    meta_rows[tk] = m
            try:
                lr = (
                    get_supabase()
                    .table("recent_chapters")
                    .select("*")
                    .in_("title_key", tks)
                    .execute()
                )
                for row in (lr.data or []):
                    tk = row.get("title_key", "")
                    if tk not in latest_rows:
                        latest_rows[tk] = row
            except Exception:
                pass

    results = []
    for r in paged:
        tk = r.get("title_key", "")
        src = r.get("source", "") or ""
        cached = meta_rows.get(tk) or {}
        lc = latest_rows.get(tk) or {}
        status = r.get("status") or cached.get("status") or "unknown"
        rating = r.get("rating") if r.get("rating") is not None else cached.get("rating")
        origin = r.get("origin") or cached.get("origin") or ""
        gen = r.get("genres") or cached.get("genres") or []
        desc = r.get("description") or cached.get("description") or ""
        latest_ch = None
        if lc:
            ch_str = str(lc.get("chapter") or "0")
            ch_num = int(re.sub(r"\D", "", ch_str) or 0)
            latest_ch = {
                "number": ch_num,
                "url": lc.get("chapter_url", ""),
                "sentAt": lc.get("updated_time", ""),
                "source": lc.get("source", ""),
            }
        results.append(
            {
                "titleKey": tk,
                "title": r.get("title", "") or cached.get("title", ""),
                "cover": cover_ref(tk),
                "status": status,
                "source": src,
                "rating": rating,
                "type": r.get("type") or cached.get("type") or None,
                "sources": [src] if src else [],
                "metadata": {
                    "status": status,
                    "rating": rating,
                    "genres": gen,
                    "description": desc,
                    "origin": origin or src,
                },
                "latestChapter": latest_ch,
            }
        )

    return JSONResponse(
        content={
            "success": True,
            "data": {
                "results": results,
                "total": total,
                "page": page,
                "pageSize": page_size,
                "totalPages": total_pages,
            },
        }
    )


@router.get("/catalog/chapters/{title_key}")
async def catalog_chapters(title_key: str, request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    tk = _up.unquote(title_key)
    if ":" in tk:
        tk = tk.split(":", 1)[0]
    tk = deslugify_title_key(tk)  # FE encodes spaces as dashes in URL path
    norm_tk = normalize_title_key(tk)

    # 60s cache: chapter lists don't change every second; avoids the
    # transaction-pooler round-trip cost on every detail-page open.
    _now = _qtime.monotonic()
    if _CAT_CH_CACHE[0] is not None and _CAT_CH_CACHE[1] == norm_tk and (_now - _CAT_CH_CACHE[0]) < _CAT_CH_TTL:
        return JSONResponse(content=_CAT_CH_CACHE[2])

    try:
        res = (
            get_supabase()
            .table("recent_chapters")
            .select("title_key, title, source, chapter, chapter_url, cover, series_url, origin, updated_time")
            .eq("title_key", norm_tk)
            .order("updated_time", desc=True)
            .limit(50)
            .execute()
        )
        rows: list[dict] = res.data or []

        def _ch_num(r: dict) -> int:
            c = str(r.get("chapter") or "").strip()
            m = re.search(r"(\d+)", c)
            return int(m.group(1)) if m else 0

        rows.sort(key=_ch_num, reverse=True)
        # Fallback: if recent_chapters is empty, use dispatch_history for this title_key.
        if not rows:
            try:
                from datetime import datetime, timezone, timedelta
                cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
                dh = (
                    get_supabase()
                    .table("dispatch_history")
                    .select("chapter_url, title_key, source, chapter_title, sent_at, fcfs_key")
                    .eq("title_key", norm_tk)
                    .gte("sent_at", cutoff)
                    .order("sent_at", desc=True)
                    .limit(50)
                    .execute()
                )
                wl_lookup: dict[str, dict] = {}
                try:
                    for w in (wl_store.load_whitelist() or []):
                        wl_lookup[normalize_title_key(str(w.get("title_key") or ""))] = w
                except Exception:
                    pass
                for r in (dh.data or []):
                    row_tk = r.get("title_key") or norm_tk
                    wl = wl_lookup.get(normalize_title_key(row_tk)) or {}
                    rows.append({
                        "title_key": row_tk,
                        "title": wl.get("title") or "",
                        "source": r.get("source") or "",
                        "chapter": r.get("chapter_title") or "",
                        "chapter_url": r.get("chapter_url") or "",
                        "cover": wl.get("cover") or "",
                        "series_url": wl.get("series_url") or wl.get("url") or "",
                        "origin": wl.get("origin") or "",
                        "updated_time": r.get("sent_at") or "",
                    })
            except Exception:
                pass
        payload = {
            "success": True,
            "data": {
                "results": rows,
                "total": len(rows),
                "titleKey": norm_tk,
            },
        }
        _CAT_CH_CACHE[0] = _qtime.monotonic()
        _CAT_CH_CACHE[1] = norm_tk
        _CAT_CH_CACHE[2] = payload
        return JSONResponse(content=payload)
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.get("/catalog/resolve")
async def catalog_resolve(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    url = request.query_params.get("url", "")
    if not url:
        return JSONResponse(content={"success": False, "error": "url required"}, status_code=400)

    # Determine source from URL host/path.
    parsed = _up.urlparse(url)
    host = (parsed.hostname or "").lower()
    source = ""
    if "ikiru" in host:
        source = "ikiru"
    elif "shinigami" in host:
        source = "shinigami"

    try:
        if source == "ikiru":
            from app.scrapers import ikiru
            slug = url.rstrip("/").split("/")[-1]
            s = ikiru.get_ikiru_series(slug)
            if not s:
                return JSONResponse(content={"success": False, "error": "not found"}, status_code=404)
            tk = s.get("title_key") or slug
            return JSONResponse(
                content={
                    "success": True,
                    "data": {
                        "titleKey": tk,
                        "title": s.get("title"),
                        "cover": scrub_cover(s.get("cover") or cover_ref(tk)),
                        "source": "ikiru",
                        "url": url,
                    },
                }
            )
        elif source == "shinigami":
            from app.scrapers import shinigami as _sh_scraper
            # Shinigami series detail API may not expose a public series endpoint,
            # so resolve via search + DB lookup instead.
            series_id = url.rstrip("/").split("/")[-1]
            s = _sh_scraper.get_shinigami_series(series_id)
            if s:
                tk = s.get("title_key") or series_id
                return JSONResponse(
                    content={
                        "success": True,
                        "data": {
                            "titleKey": tk,
                            "title": s.get("title"),
                            "cover": scrub_cover(s.get("cover") or cover_ref(tk)),
                            "source": "shinigami",
                            "url": url,
                        },
                    }
                )
            # Fallback 1: match via chapter history by finding rows whose
            # chapter_url contains the requested series ID.
            try:
                from app.db import get_supabase
                sb = get_supabase()
                ch = (
                    sb.table("recent_chapters")
                    .select("title_key,title,cover,series_url,source")
                    .eq("source", "shinigami")
                    .limit(200)
                    .execute()
                    .data
                    or []
                )
                for row in ch:
                    if series_id in (row.get("chapter_url") or ""):
                        tk = row.get("title_key") or series_id
                        return JSONResponse(
                            content={
                                "success": True,
                                "data": {
                                    "titleKey": tk,
                                    "title": row.get("title"),
                                    "cover": scrub_cover(row.get("cover") or cover_ref(tk)),
                                    "source": "shinigami",
                                    "url": row.get("series_url") or url,
                                },
                            }
                        )
            except Exception:
                pass
            # Final fallback: return a 200 stub so unknown but valid shinigami URLs
            # don't break the FE. titleKey is derived from URL slug/series ID.
            try:
                fallback_title = _up.unquote(series_id).replace("-", " ").strip()
                fallback_tk = normalize_title_key(fallback_title) or series_id
                return JSONResponse(
                    content={
                        "success": True,
                        "data": {
                            "titleKey": fallback_tk,
                            "title": fallback_title or series_id,
                            "cover": scrub_cover(cover_ref(fallback_tk)),
                            "source": "shinigami",
                            "url": url,
                        },
                    }
                )
            except Exception:
                return JSONResponse(content={"success": False, "error": "not found"}, status_code=404)
        else:
            return JSONResponse(
                content={"success": False, "error": f"unsupported source: {source or 'unknown'}; must be ikiru or shinigami URL"},
                status_code=400,
            )
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.get("/catalog/badge-counts")
@router.get("/reader/badge-counts")
async def badge_counts(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    # Short in-memory cache: FE polls every 30s, so a 15s TTL means at
    # most 1 DB hit per ~15s instead of 1 per poll. Keeps the endpoint
    # cheap without changing the FE contract.
    _now = _qtime.time()
    _cached = _BADGE_CACHE.get("badge")
    if _cached is not None and (_now - _cached[0]) < 15:
        return JSONResponse(content=_cached[1], headers={"Cache-Control": "private, max-age=30"})

    try:
        sb = get_supabase()
        fd_res = (
            sb.table("failed_dispatches")
            .select("*", count="exact")
            .eq("status", "failed")
            .execute()
        )
        failed = fd_res.count or 0
        payload = {
            "success": True,
            "data": {
                "activeIncidents": 0,
                "failedDispatches": failed,
                "unreadCount": 0,
            },
        }
        _BADGE_CACHE["badge"] = (_qtime.time(), payload)
        if len(_BADGE_CACHE) > _BADGE_CACHE_MAX:
            _BADGE_CACHE.popitem(last=False)
        return JSONResponse(content=payload, headers={"Cache-Control": "private, max-age=30"})
    except Exception:
        return JSONResponse(
            content={"success": True, "data": {"activeIncidents": 0, "failedDispatches": 0, "unreadCount": 0}},
            headers={"Cache-Control": "private, max-age=30"},
        )


@router.get("/catalog/{title_key}")
async def catalog_item(title_key: str, request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase
    from app.utils.text import normalize_title_key

    _now = _qtime.time()
    _cache_key = f"catalog:{title_key}"
    _cached = _CATALOG_CACHE.get(_cache_key)
    if _cached is not None and (_now - _cached[0]) < _CATALOG_TTL:
        return JSONResponse(content=_cached[1])

    tk_norm = normalize_title_key(title_key)
    slug = slugify_title_key(title_key)

    sb = get_supabase()
    meta = None
    try:
        mres = sb.table("whitelist").select("*").in_("title_key", [title_key, tk_norm, slug]).limit(5).execute()
        for m in (mres.data or []):
            if m.get("title_key") in (title_key, tk_norm, slug):
                meta = m
                break
        if not meta and (mres.data or []):
            meta = mres.data[0]
    except Exception:
        pass

    sources = []
    wl_row = None
    try:
        wres = sb.table("whitelist").select("*").in_("title_key", [title_key, tk_norm]).limit(5).execute()
        for w in (wres.data or []):
            if w.get("title_key") in (title_key, tk_norm):
                wl_row = w
                break
    except Exception:
        pass

    # Build sources from recent_chapters (has correct per-source series_url),
    # not from whitelist (series_url column doesn't exist there).
    try:
        rc_res = (
            sb.table("recent_chapters")
            .select("source, series_url")
            .in_("title_key", [title_key, deslugify_title_key(title_key), tk_norm, slug])
            .execute()
        )
        seen = {}
        for rc in (rc_res.data or []):
            s = rc.get("source")
            su = rc.get("series_url") or ""
            if s and s not in seen and su:
                seen[s] = su
        for s, su in seen.items():
            sources.append({"source": s, "url": su})
    except Exception:
        pass

    if not sources and wl_row:
        _src = wl_row.get("source") or "ikiru"
        _url = (wl_row.get("series_url") or wl_row.get("url")
                or f"{settings.IKIRU_BASE_URL.rstrip(chr(47))}/manga/{slug}/")
        sources = [{"source": _src, "url": _url}]

    if meta or wl_row:
        _resp = {
            "success": True,
            "data": {
                "titleKey": title_key,
                "title": (meta or {}).get("title") or (wl_row or {}).get("title") or title_key,
                "cover": scrub_cover((meta or {}).get("cover") or (wl_row or {}).get("cover") or ""),
                "sources": sources,
                "metadata": {
                    "status": (meta or {}).get("status") or (wl_row or {}).get("status") or "",
                    "rating": (meta or {}).get("rating") or (wl_row or {}).get("rating") or "",
                    "genres": (meta or {}).get("genres") or (wl_row or {}).get("genres") or [],
                    "description": (meta or {}).get("description") or "",
                    "origin": (meta or {}).get("origin") or (wl_row or {}).get("origin") or "",
                },
                "latestChapter": None,
            },
        }
        _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
        _CATALOG_CACHE.move_to_end(_cache_key)
        while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
            _CATALOG_CACHE.popitem(last=False)
        return JSONResponse(content=_resp)

    from app.scrapers import ikiru

    s = ikiru.get_ikiru_series(slug)
    if not s:
        _resp = {"success": False, "error": "not found"}
        _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
        _CATALOG_CACHE.move_to_end(_cache_key)
        while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
            _CATALOG_CACHE.popitem(last=False)
        return JSONResponse(content=_resp, status_code=404)
    _resp = {
        "success": True,
        "data": {
            "titleKey": title_key,
            "title": s.get("title"),
            "cover": cover_ref(title_key),
            "sources": [{"source": "ikiru", "url": s.get("permalink")}],
            "metadata": {
                "status": "ongoing" if s.get("is_project") else "completed",
                "rating": s.get("rating"),
                "genres": s.get("genre", []),
                "description": "",
                "origin": "ikiru",
            },
            "latestChapter": None,
        },
    }
    _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
    _CATALOG_CACHE.move_to_end(_cache_key)
    while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
        _CATALOG_CACHE.popitem(last=False)
    return JSONResponse(content=_resp)


# In-memory cache for /catalog/{title_key} (5 min TTL)
_CATALOG_CACHE: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_CATALOG_CACHE_MAX = 256
_CATALOG_TTL = 300  # 5 minutes

# In-memory cache for /reader/badge-counts (15s TTL, see badge_counts())
_BADGE_CACHE: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_BADGE_CACHE_MAX = 32
