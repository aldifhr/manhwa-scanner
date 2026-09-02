"""Auto-split from dashboard.py — catalog routes."""
import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.utils.request_auth import require_monitor_auth
from app.utils.cover_scrub import cover_ref
from app.logger import get_logger
from app.storage import whitelist as wl_store
from app.utils.origin import normalize_origin
from app.utils.text import normalize_title_key
logger = get_logger("api:catalog")
router = APIRouter()


@router.get("/catalog/search")
async def catalog_search(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    q = request.query_params.get("q", "")
    from app.scrapers import ikiru, shinigami

    # C1 FIX: Run blocking scrapers in thread pool to avoid blocking event loop
    ikiru_results, shinigami_results = await asyncio.gather(
        asyncio.to_thread(ikiru.search_ikiru_api, q, 10),
        asyncio.to_thread(shinigami.search_shinigami_api, q, 10),
    )
    raw = ikiru_results + shinigami_results
    for _r in raw:
        if not _r.get("source"):
            _perm = _r.get("permalink", "") or ""
            _r["source"] = "ikiru" if _perm.startswith("https://07.ikiru") else "shinigami"
    from app.storage import whitelist as _wl_store
    _wl_keys = set()
    try:
        for _w in (_wl_store.load_whitelist() or []):
            _tk = _w.get("title_key") or ""
            if _tk:
                _wl_keys.add(normalize_title_key(_tk))
    except Exception:
        pass
    results = []
    for r in raw:
        src = r.get("source") or ""
        title = r.get("title") or ""
        if not title:
            continue
        slug = r.get("slug") or r.get("permalink", "").rstrip("/").split("/")[-1] or normalize_title_key(title)
        _raw_origin = r.get("origin") or r.get("type") or []
        if isinstance(_raw_origin, list):
            _raw_origin = _raw_origin[0] if _raw_origin else ""
        _origin_cc = normalize_origin(_raw_origin)
        if not _origin_cc:
            _origin_cc = "KR" if src == "ikiru" else ("JP" if src == "shinigami" else "")
        _is_wl = normalize_title_key(slug) in _wl_keys
        results.append({
            "title": title,
            "titleKey": slug,
            "cover": cover_ref(slug),
            "source": src,
            "url": r.get("permalink") or r.get("url") or r.get("series_url") or (f"https://11.shinigami.asia/series/{r.get('manga_id')}" if src == "shinigami" and r.get("manga_id") else ""),
            "origin": _origin_cc,
            "isInWhitelist": _is_wl,
        })
    return JSONResponse(content={"success": True, "data": {"results": results, "count": len(results)}})


@router.get("/catalog/stats")
async def catalog_stats(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    rows = wl_store.load_whitelist() or []
    total = len(rows)
    status_distribution: dict[str, int] = {}
    source_distribution: dict[str, int] = {}
    rating_buckets = {"0-2": 0, "3-5": 0, "6-8": 0, "9-10": 0, "unrated": 0}
    total_with_rating = 0
    for r in rows:
        src = r.get("source") or "unknown"
        source_distribution[src] = source_distribution.get(src, 0) + 1
        rating = r.get("rating")
        if rating is None:
            rating_buckets["unrated"] += 1
        else:
            try:
                v = float(rating)
                total_with_rating += 1
                if v < 3:
                    rating_buckets["0-2"] += 1
                elif v < 6:
                    rating_buckets["3-5"] += 1
                elif v < 9:
                    rating_buckets["6-8"] += 1
                else:
                    rating_buckets["9-10"] += 1
            except Exception:
                rating_buckets["unrated"] += 1
    return JSONResponse(
        content={
            "success": True,
            "data": {
                "total": total,
                "statusDistribution": status_distribution,
                "sourceDistribution": source_distribution,
                "ratingBuckets": {"buckets": rating_buckets, "totalWithRating": total_with_rating},
            },
            "whitelist_count": total,
        }
    )
