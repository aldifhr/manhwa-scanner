"""Cover image proxy — single seam for /reader/cover, /reader/cover-img, /reader/proxy, /img."""

from __future__ import annotations

import asyncio
import base64
import re
import time as _time
from asyncio import Lock
from collections import OrderedDict
from typing import TYPE_CHECKING
from urllib.parse import quote, urlparse, urlsplit, urlunsplit, parse_qsl, urlencode, unquote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response as FastResponse

from app.config import settings
from app.logger import get_logger
from app.utils.cover_scrub import scrub_cover

if TYPE_CHECKING:
    pass

logger = get_logger("api:cover")
router = APIRouter()

_COVER_CACHE: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()
_COVER_CACHE_TTL = 86400
_COVER_CACHE_MAX = 200

_url_locks: dict[str, Lock] = {}
_url_locks_lock = Lock()


async def _url_lock(url: str) -> Lock:
    async with _url_locks_lock:
        if url not in _url_locks:
            _url_locks[url] = Lock()
        return _url_locks[url]


def _cache_get(url: str):
    entry = _COVER_CACHE.get(url)
    if entry and (_time.monotonic() - entry[0]) < _COVER_CACHE_TTL:
        return entry[1]
    return None


def _cache_put(url: str, val: bytes):
    _COVER_CACHE[url] = (_time.monotonic(), val)
    while len(_COVER_CACHE) > _COVER_CACHE_MAX:
        _COVER_CACHE.popitem(last=False)


def _detect_ctype(content: bytes) -> str:
    if content[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if content[:4] == b"\x89PNG":
        return "image/png"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    if content[:4] == b" GIF":
        return "image/gif"
    return "image/jpeg"


# 1x1 transparent PNG
_PX1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

_RESPONSE_SIZE_CAP = 5 * 1024 * 1024  # 5MB


async def _fetch_image(url: str, cache_control: str = "public, max-age=86400") -> "FastResponse":
    p = urlparse(url)
    try:
        allowed = settings.get_proxy_hosts()
    except Exception:
        allowed = getattr(settings, "PROXY_ALLOWED_HOSTS", []) or [
            "g.shinigami.asia:443",
            "shinigami.asia:443",
            "assets.shngm.id:443",
        ]
    host = (p.hostname or "").strip().lower()
    port = p.port or (443 if p.scheme == "https" else 80)
    host_port = f"{host}:{port}"
    if p.scheme not in ("http", "https") or host_port not in allowed:
        return FastResponse(status_code=403)
    cached = _cache_get(url)
    if cached is not None:
        headers = {"Cache-Control": cache_control, "X-Cache": "HIT"}
        if "86400" in cache_control:
            headers["Expires"] = "Thu, 31 Dec 2026 23:59:59 GMT"
        return FastResponse(content=cached, status_code=200, media_type=_detect_ctype(cached), headers=headers)
    lock = await _url_lock(url)
    async with lock:
        cached = _cache_get(url)
        if cached is not None:
            headers = {"Cache-Control": cache_control, "X-Cache": "HIT"}
            if "86400" in cache_control:
                headers["Expires"] = "Thu, 31 Dec 2026 23:59:59 GMT"
            return FastResponse(content=cached, status_code=200, media_type=_detect_ctype(cached), headers=headers)
        try:
            from curl_cffi import requests as cffi_req

            headers_req = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
                "Accept-Encoding": "gzip, deflate, br",
            }
            r = await asyncio.to_thread(
                lambda: cffi_req.get(url, headers=headers_req, impersonate="chrome", timeout=8, allow_redirects=False)
            )
            if r.status_code == 403 and "hotlink" in (r.text.lower() if hasattr(r, "text") else ""):
                for alt_ref in [f"https://{p.hostname}/", ""]:
                    alt_headers = dict(headers_req)
                    if alt_ref:
                        alt_headers["Referer"] = alt_ref
                    else:
                        alt_headers.pop("Referer", None)
                    r2 = await asyncio.to_thread(
                        lambda h=alt_headers: cffi_req.get(url, headers=h, impersonate="chrome", timeout=8, allow_redirects=False)
                    )
                    if r2.status_code == 200:
                        r = r2
                        break
            if r.status_code == 200:
                content = r.content[:_RESPONSE_SIZE_CAP]
                _cache_put(url, content)
                ctype = r.headers.get("content-type") or _detect_ctype(content)
                headers_out = {"Cache-Control": cache_control, "X-Cache": "MISS"}
                if "86400" in cache_control:
                    headers_out["Expires"] = "Thu, 31 Dec 2026 23:59:59 GMT"
                return FastResponse(content=content, status_code=200, media_type=ctype, headers=headers_out)
            if r.status_code in (403, 404):
                # Return a 1x1 transparent PNG so <img> doesn't error/flash
                return FastResponse(content=_PX1, status_code=200, media_type="image/png", headers={"Cache-Control": "public, max-age=3600", "X-Cache": "MISS"})
            return FastResponse(status_code=r.status_code)
        except asyncio.TimeoutError:
            return FastResponse(content=_PX1, status_code=200, media_type="image/png", headers={"Cache-Control": "public, max-age=300", "X-Cache": "MISS"})
        except Exception:
            return FastResponse(status_code=502)


@router.get("/reader/cover")
async def reader_cover(request: Request):
    series = (request.query_params.get("series", "") or "").strip()
    if not series or len(series) > 80:
        return FastResponse(status_code=400)
    if not re.match(r"^[a-zA-Z0-9\-_ ]+$", series):
        return FastResponse(status_code=400)
    from app.db import get_supabase
    sb = get_supabase()
    from app.utils.text import normalize_title_key, slugify_title_key
    try:
        from app.storage.canonical import canonical_of
    except Exception:
        def canonical_of(x):
            return x
    _spaced = series.replace("-", " ")
    try:
        _norm = normalize_title_key(series)
        _slug = slugify_title_key(series)
        _canon = canonical_of(series) or _norm
        _canon_norm = normalize_title_key(_canon)
        _canon_slug = slugify_title_key(_canon)
    except Exception:
        _norm = _spaced.lower()
        _slug = re.sub(r"\s+", "-", series).lower()
        _canon = _norm
        _canon_norm = _norm
        _canon_slug = _slug
    candidates = {
        series,
        _spaced,
        re.sub(r"\s+", "-", series),
        series.lower(),
        _spaced.lower(),
        _norm,
        _slug,
        _canon,
        _canon_norm,
        _canon_slug,
    }
    try:
        res = sb.table("recent_chapters").select("cover,title").in_("title_key", list(candidates)).limit(10).execute()
        for r in (res.data or []):
            c = r.get("cover")
            if c and isinstance(c, str) and c.startswith("http"):
                return await _fetch_image(c)
    except Exception as e:
        logger.warn("cover: recent_chapters cover lookup failed", err=str(e)[:120])
    try:
        # `title` is not a column on series_meta. Selecting it made this query
        # raise UndefinedColumn every time, so the fallback never ran and the
        # request fell straight to 404 — the one path meant to still find a
        # cover when recent_chapters had none.
        res2 = sb.table("series_meta").select("cover").in_("title_key", list(candidates)).limit(10).execute()
        for r in (res2.data or []):
            c = r.get("cover")
            if c and isinstance(c, str) and c.startswith("http"):
                return await _fetch_image(c)
    except Exception as e:
        logger.warn("cover: series_meta cover lookup failed", err=str(e)[:120])
    return FastResponse(status_code=404)


@router.get("/reader/proxy")
async def reader_proxy(request: Request):
    raw_query = request.url.query or ""
    if raw_query.startswith("url="):
        url = raw_query[4:]
    else:
        url = request.query_params.get("url", "")
    url = (url or "").strip()
    if not url:
        return FastResponse(status_code=400)
    _guard = 0
    while re.search(r"%[0-9A-Fa-f]{2}", url) and not url.lower().startswith(("http://", "https://")) and _guard < 5:
        try:
            url = unquote(url)
        except Exception:
            break
        _guard += 1
    try:
        urlparse(url)
    except ValueError:
        return FastResponse(status_code=400)
    return await _fetch_image(url)


@router.get("/reader/cover-img")
async def reader_cover_img(request: Request):
    return await reader_proxy(request)


@router.get("/img")
async def img(request: Request):
    url = (request.query_params.get("url") or "").strip()
    if not url:
        return FastResponse(status_code=400)
    _guard = 0
    while re.search(r"%[0-9A-Fa-f]{2}", url) and not url.lower().startswith(("http://", "https://")) and _guard < 5:
        try:
            url = unquote(url)
        except Exception:
            break
        _guard += 1
    try:
        urlparse(url)
    except ValueError:
        return FastResponse(status_code=400)
    return await _fetch_image(url)


@router.get("/reader/refresh-cover")
async def reader_refresh_cover(request: Request):
    """Return fresh cover URL for a series — used by FE to refresh expired presigned URLs."""
    series = (request.query_params.get("series", "") or "").strip()
    source = (request.query_params.get("source", "") or "").strip().lower()
    if not series or len(series) > 80:
        return JSONResponse(content={"success": False, "error": "invalid series"}, status_code=400)

    from app.db import get_supabase, q
    from app.config import settings as _cfg
    from fastapi.responses import JSONResponse

    sb = get_supabase()
    _spaced = series.replace("-", " ")
    candidates = list({series, _spaced, re.sub(r"\s+", "-", series), series.lower(), _spaced.lower()})

    # Find stored cover URL
    stored_cover = None
    try:
        for tbl in ("recent_chapters", "series_meta", "whitelist"):
            try:
                res = sb.table(tbl).select("cover").in_("title_key", candidates).limit(3).execute()
                for r in (res.data or []):
                    c = r.get("cover")
                    if c:
                        stored_cover = c
                        break
                if stored_cover:
                    break
            except Exception:
                continue
    except Exception as e:
        logger.warn("cover: series_meta cover lookup failed", err=str(e)[:120])

    if not stored_cover:
        return JSONResponse(content={"success": False, "error": "no cover found"}, status_code=404)

    return JSONResponse(content={"success": True, "cover": stored_cover})
