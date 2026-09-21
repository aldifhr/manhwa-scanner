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
    # public read — series detail page (was monitor-only, now open for FE deep link)
    from app.db import get_supabase
    _source_q = (request.query_params.get("source") or "").strip().lower()
    _now = _qtime.time()
    _cache_key = f"catalog:{title_key}:{_source_q}" if _source_q else f"catalog:{title_key}"
    _cached = _CATALOG_CACHE.get(_cache_key)
    if _cached is not None and (_now - _cached[0]) < _CATALOG_TTL:
        return JSONResponse(content=_cached[1])
    # source-aware early fetch — Popular cards pass ?source=voratoon/shinigami so voratoon slug doesn't get hijacked by ikiru whitelist
    if _source_q == "voratoon":
        try:
            import httpx as _httpx
            with _httpx.Client(timeout=8.0) as _c:
                r = _c.get(f"{settings.VORATOON_API_URL.rstrip('/')}/series/{title_key}", headers={"Accept": "application/json"})
                if r.status_code == 200:
                    j = r.json()
                    data = (j.get("data") or {}).get("data") or j.get("data") or {}
                    if data and data.get("title"):
                        cover = data.get("coverImage") or ""
                        cover = scrub_cover(cover) or cover if cover else ""
                        genres = [g.get("data", {}).get("name", "") for g in (data.get("genres") or []) if g.get("data", {}).get("name")]
                        _resp = {"success": True, "data": {"titleKey": title_key, "title": data.get("title") or title_key, "cover": cover, "sources": [{"source": "voratoon", "url": f"https://{settings.VORATOON_DOMAIN}/series/{title_key}"}], "metadata": {"status": data.get("status") or "", "rating": data.get("rating") or "", "genres": genres, "description": data.get("synopsis") or "", "origin": "CN" if (data.get("format") or "").lower()=="manhua" else "KR"}, "latestChapter": str(data.get("totalChapters") or "")}}
                        _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
                        _CATALOG_CACHE.move_to_end(_cache_key)
                        while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
                            _CATALOG_CACHE.popitem(last=False)
                        return JSONResponse(content=_resp)
        except Exception:
            pass
    if _source_q == "shinigami" and __import__("re").match(r"^[0-9a-fA-F-]{36}$", title_key):
        try:
            from curl_cffi import requests as _cffi2
            r = _cffi2.get(f"{settings.SHINIGAMI_API_BASE.rstrip('/')}/v1/manga/detail/{title_key}", impersonate="chrome", timeout=10)
            if r.status_code == 200:
                j = r.json()
                d = j.get("data") or j
                if d and d.get("title"):
                    cover = d.get("cover_image_url") or d.get("cover_portrait_url") or ""
                    cover = scrub_cover(cover) or cover if cover else ""
                    genres = []
                    tax = d.get("taxonomy") or {}
                    for g in (tax.get("Genre") or []):
                        if g.get("name"):
                            genres.append(g["name"])
                    _resp = {"success": True, "data": {"titleKey": title_key, "title": d.get("title") or title_key, "cover": cover, "sources": [{"source": "shinigami", "url": f"{settings.SHINIGAMI_PUBLIC_BASE.rstrip('/')}/series/{title_key}"}], "metadata": {"status": "ongoing" if d.get("status")==1 else "completed", "rating": d.get("user_rate") or "", "genres": genres, "description": d.get("description") or "", "origin": d.get("country_id") or "KR"}, "latestChapter": str(d.get("latest_chapter_number") or "")}}
                    _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
                    _CATALOG_CACHE.move_to_end(_cache_key)
                    while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
                        _CATALOG_CACHE.popitem(last=False)
                    return JSONResponse(content=_resp)
        except Exception:
            pass
    tk_norm = normalize_title_key(title_key)
    slug = slugify_title_key(title_key)
    sb = get_supabase()
    # UUID whitelist-id resolution — convert to title_key for all lookups
    import re as _re_uuid2
    if _re_uuid2.match(r"^[0-9a-fA-F-]{36}$", title_key):
        try:
            uuid_row = sb.table("whitelist").select("title_key").eq("id", title_key).limit(1).execute()
            if uuid_row.data:
                title_key = uuid_row.data[0].get("title_key") or title_key
                tk_norm = normalize_title_key(title_key)
                slug = slugify_title_key(title_key)
        except Exception:
            pass
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
    # No fallback for non-whitelisted recent_chapters — return 404 instead of empty cover/metadata
    if meta or wl_row:
        _resp = {"success": True, "data": {"titleKey": title_key, "title": (meta or {}).get("title") or (wl_row or {}).get("title") or title_key, "cover": scrub_cover((meta or {}).get("cover") or (wl_row or {}).get("cover") or ""), "sources": sources, "metadata": {"status": (meta or {}).get("status") or (wl_row or {}).get("status") or "", "rating": (meta or {}).get("rating") or (wl_row or {}).get("rating") or "", "genres": (meta or {}).get("genres") or (wl_row or {}).get("genres") or [], "description": (meta or {}).get("description") or "", "origin": (meta or {}).get("origin") or (wl_row or {}).get("origin") or ""}, "latestChapter": None}}
        _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
        _CATALOG_CACHE.move_to_end(_cache_key)
        while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
            _CATALOG_CACHE.popitem(last=False)
        return JSONResponse(content=_resp)
    from app.scrapers.ikiru import get_ikiru_series
    s = get_ikiru_series(slug)
    if s:
        _resp = {"success": True, "data": {"titleKey": title_key, "title": s.get("title"), "cover": cover_ref(title_key), "sources": [{"source": "ikiru", "url": s.get("permalink")}], "metadata": {"status": "ongoing" if s.get("is_project") else "completed", "rating": s.get("rating"), "genres": s.get("genre", []), "description": "", "origin": "ikiru"}, "latestChapter": None}}
        _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
        _CATALOG_CACHE.move_to_end(_cache_key)
        while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
            _CATALOG_CACHE.popitem(last=False)
        return JSONResponse(content=_resp)

    # Fallback: Shinigami detail by manga_id (UUID) — for Popular today
    if _re_uuid2.match(r"^[0-9a-fA-F-]{36}$", title_key):
        try:
            from curl_cffi import requests as _cffi
            r = _cffi.get(f"{settings.SHINIGAMI_API_BASE.rstrip('/')}/v1/manga/detail/{title_key}", impersonate="chrome", timeout=10)
            if r.status_code == 200:
                j = r.json()
                d = j.get("data") or j
                if d and d.get("title"):
                    cover = d.get("cover_image_url") or d.get("cover_portrait_url") or ""
                    cover = scrub_cover(cover) or cover if cover else ""
                    genres = []
                    tax = d.get("taxonomy") or {}
                    for g in (tax.get("Genre") or []):
                        if g.get("name"):
                            genres.append(g["name"])
                    _resp = {"success": True, "data": {"titleKey": title_key, "title": d.get("title") or title_key, "cover": cover, "sources": [{"source": "shinigami", "url": f"{settings.SHINIGAMI_PUBLIC_BASE.rstrip('/')}/series/{title_key}"}], "metadata": {"status": "ongoing" if d.get("status")==1 else "completed", "rating": d.get("user_rate") or "", "genres": genres, "description": d.get("description") or "", "origin": d.get("country_id") or "KR"}, "latestChapter": str(d.get("latest_chapter_number") or "")}}
                    _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
                    _CATALOG_CACHE.move_to_end(_cache_key)
                    while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
                        _CATALOG_CACHE.popitem(last=False)
                    return JSONResponse(content=_resp)
        except Exception:
            pass

    # Fallback: Voratoon by slug
    try:
        import httpx as _httpx2
        with _httpx2.Client(timeout=8.0) as _c:
            r = _c.get(f"{settings.VORATOON_API_URL.rstrip('/')}/series/{title_key}", headers={"Accept": "application/json"})
            if r.status_code == 200:
                j = r.json()
                data = (j.get("data") or {}).get("data") or j.get("data") or {}
                if data and data.get("title"):
                    cover = data.get("coverImage") or ""
                    cover = scrub_cover(cover) or cover if cover else ""
                    genres = [g.get("data", {}).get("name", "") for g in (data.get("genres") or []) if g.get("data", {}).get("name")]
                    _resp = {"success": True, "data": {"titleKey": title_key, "title": data.get("title") or title_key, "cover": cover, "sources": [{"source": "voratoon", "url": f"https://{settings.VORATOON_DOMAIN}/series/{title_key}"}], "metadata": {"status": data.get("status") or "", "rating": data.get("rating") or "", "genres": genres, "description": data.get("synopsis") or "", "origin": "CN" if (data.get("format") or "").lower()=="manhua" else "KR"}, "latestChapter": str(data.get("totalChapters") or "")}}
                    _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
                    _CATALOG_CACHE.move_to_end(_cache_key)
                    while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
                        _CATALOG_CACHE.popitem(last=False)
                    return JSONResponse(content=_resp)
    except Exception:
        pass

    _resp = {"success": False, "error": "not found"}
    _CATALOG_CACHE[_cache_key] = (_qtime.time(), _resp)
    _CATALOG_CACHE.move_to_end(_cache_key)
    while len(_CATALOG_CACHE) > _CATALOG_CACHE_MAX:
        _CATALOG_CACHE.popitem(last=False)
    return JSONResponse(content=_resp, status_code=404)
