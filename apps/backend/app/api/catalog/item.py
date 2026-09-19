"""Catalog item — GET /catalog/{title_key}."""
import time as _qtime
from collections import OrderedDict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.config import settings
from app.utils.text import slugify_title_key, deslugify_title_key, normalize_title_key
from app.logger import get_logger
from app.utils.request_auth import safe_error, require_monitor_auth
from app.utils.cover_scrub import scrub_cover, cover_ref

logger = get_logger("api:catalog:item")
router = APIRouter()

_CATALOG_CACHE: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_CATALOG_CACHE_MAX = 256
_CATALOG_TTL = 300


@router.get("/catalog/{title_key}")
async def catalog_item(title_key: str, request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase
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
    try:
        rc_res = sb.table("recent_chapters").select("source, series_url").in_("title_key", [title_key, deslugify_title_key(title_key), tk_norm, slug]).execute()
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
        _url = wl_row.get("series_url") or wl_row.get("url") or f"{settings.IKIRU_BASE_URL.rstrip(chr(47))}/manga/{slug}/"
        sources = [{"source": _src, "url": _url}]
    if meta or wl_row:
        _resp = {"success": True, "data": {"titleKey": title_key, "title": (meta or {}).get("title") or (wl_row or {}).get("title") or title_key, "cover": scrub_cover((meta or {}).get("cover") or (wl_row or {}).get("cover") or ""), "sources": sources, "metadata": {"status": (meta or {}).get("status") or (wl_row or {}).get("status") or "", "rating": (meta or {}).get("rating") or (wl_row or {}).get("rating") or "", "genres": (meta or {}).get("genres") or (wl_row or {}).get("genres") or [], "description": (meta or {}).get("description") or "", "origin": (meta or {}).get("origin") or (wl_row or {}).get("origin") or ""}, "latestChapter": None}}
        _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
        _CATALOG_CACHE.move_to_end(_cache_key)
        while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
            _CATALOG_CACHE.popitem(last=False)
        return JSONResponse(content=_resp)
    from app.scrapers.ikiru import get_ikiru_series
    s = get_ikiru_series(slug)
    if not s:
        _resp = {"success": False, "error": "not found"}
        _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
        _CATALOG_CACHE.move_to_end(_cache_key)
        while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
            _CATALOG_CACHE.popitem(last=False)
        return JSONResponse(content=_resp, status_code=404)
    _resp = {"success": True, "data": {"titleKey": title_key, "title": s.get("title"), "cover": cover_ref(title_key), "sources": [{"source": "ikiru", "url": s.get("permalink")}], "metadata": {"status": "ongoing" if s.get("is_project") else "completed", "rating": s.get("rating"), "genres": s.get("genre", []), "description": "", "origin": "ikiru"}, "latestChapter": None}}
    _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
    _CATALOG_CACHE.move_to_end(_cache_key)
    while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
        _CATALOG_CACHE.popitem(last=False)
    return JSONResponse(content=_resp)
