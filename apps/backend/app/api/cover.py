"""Cover image proxy — single seam for /reader/cover, /reader/cover-img, /reader/proxy, /img."""
import asyncio
import re
import time as _time
import hashlib as _hashlib
import os as _os

from fastapi import APIRouter, Request
from fastapi.responses import Response as FastResponse
from fastapi.responses import JSONResponse

from app.config import settings
from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth, safe_error

logger = get_logger("api:cover")
router = APIRouter()

# --- Image proxy shared ---
import httpx

_RE_RESPONSE_SIZE_CAP = 10 * 1024 * 1024

_image_cache_dir_env = _os.environ.get("IMAGE_CACHE_DIR")
if not _image_cache_dir_env:
    _image_cache_dir_env = _os.path.join(_os.sep, "tmp", "be_ag_cache")
    _os.makedirs(_image_cache_dir_env, exist_ok=True)
_IMAGE_CACHE_DIR: str = _image_cache_dir_env
_IMAGE_CACHE_MAX = 2000
_URL_FETCH_LOCKS: dict[str, asyncio.Lock] = {}
_URL_LOCKS_GUARD = asyncio.Lock()
_URL_FETCH_LOCKS_LAST_USED: dict[str, float] = {}
_URL_FETCH_LOCKS_MAX = 1000


async def _url_lock(url: str):
    async with _URL_LOCKS_GUARD:
        if url not in _URL_FETCH_LOCKS:
            if len(_URL_FETCH_LOCKS) >= _URL_FETCH_LOCKS_MAX:
                _evict_oldest_locks()
            _URL_FETCH_LOCKS[url] = asyncio.Lock()
        _URL_FETCH_LOCKS_LAST_USED[url] = _time.time()
    return _URL_FETCH_LOCKS[url]


def _evict_oldest_locks():
    if len(_URL_FETCH_LOCKS) < _URL_FETCH_LOCKS_MAX:
        return
    sorted_urls = sorted(_URL_FETCH_LOCKS_LAST_USED.items(), key=lambda x: x[1])
    to_evict = sorted_urls[: len(sorted_urls) // 4]
    for url, _ in to_evict:
        _URL_FETCH_LOCKS.pop(url, None)
        _URL_FETCH_LOCKS_LAST_USED.pop(url, None)


def _cache_path(url: str) -> str:
    _os.makedirs(_IMAGE_CACHE_DIR, exist_ok=True)
    key = _hashlib.sha256(url.encode()).hexdigest()[:32]
    return _os.path.join(_IMAGE_CACHE_DIR, key)


def _cache_get(url: str, max_age: int = 3600) -> bytes | None:
    p = _cache_path(url)
    try:
        if _os.path.exists(p):
            if (_time.time() - _os.path.getmtime(p)) > max_age:
                return None
            _os.utime(p, None)
            with open(p, "rb") as f:
                return f.read()
    except Exception as e:
        logger.warn("cover cache get failed", url=url[:80], err=str(e)[:160])
        return None
    return None


def _cache_put(url: str, data: bytes) -> None:
    try:
        if _os.path.isdir(_IMAGE_CACHE_DIR):
            try:
                entries = [_os.path.join(_IMAGE_CACHE_DIR, f) for f in _os.listdir(_IMAGE_CACHE_DIR)]
                _now = _time.time()
                _seven_days = 7 * 24 * 3600
                for p in list(entries):
                    try:
                        if (_now - _os.path.getmtime(p)) > _seven_days:
                            _os.remove(p)
                            entries.remove(p)
                    except Exception:
                        pass
                if len(entries) >= _IMAGE_CACHE_MAX:
                    entries.sort(key=lambda e: _os.path.getmtime(e))
                    for old in entries[: len(entries) - _IMAGE_CACHE_MAX + 1]:
                        try:
                            _os.remove(old)
                        except Exception:
                            pass
            except Exception:
                pass
        with open(_cache_path(url), "wb") as f:
            f.write(data)
    except Exception as e:
        logger.warn("cover cache put failed", url=url[:80], err=str(e)[:160])


def _detect_ctype(data: bytes) -> str:
    if data[:4] == b"\x89PNG":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"GIF8":
        return "image/gif"
    return "image/jpeg"


async def _fetch_image(url: str, cache_control: str = "public, max-age=86400") -> "FastResponse":
    from urllib.parse import urlparse

    p = urlparse(url)
    try:
        allowed = settings.get_proxy_hosts()
    except Exception:
        allowed = getattr(settings, "PROXY_ALLOWED_HOSTS", []) or [
            f"{settings.IKIRU_BASE_URL.rstrip('/')}:443",
            "ikiru.wtf:443",
            "g.shinigami.asia:443",
            "shinigami.asia:443",
            "assets.shngm.id:443",
            f"{settings.VORATOON_COVER_BUCKET}:443",
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
            if "ikiru.wtf" in url:
                headers_req["Referer"] = f"https://{settings.IKIRU_PUBLIC_URL.rstrip('/')}/"
                headers_req["Accept"] = "image/avif,image/webp,image/apng,*/*"
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
                content = r.content[:_RE_RESPONSE_SIZE_CAP]
                _cache_put(url, content)
                ctype = r.headers.get("content-type") or _detect_ctype(content)
                headers_out = {"Cache-Control": cache_control, "X-Cache": "MISS"}
                if "86400" in cache_control:
                    headers_out["Expires"] = "Thu, 31 Dec 2026 23:59:59 GMT"
                return FastResponse(content=content, status_code=200, media_type=ctype, headers=headers_out)
            if r.status_code in (403, 404):
                # Return a 1x1 transparent PNG so <img> doesn't error/flash
                import base64
                _PX1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
                return FastResponse(content=_PX1, status_code=200, media_type="image/png", headers={"Cache-Control": "public, max-age=3600", "X-Cache": "MISS"})
            return FastResponse(status_code=r.status_code)
        except asyncio.TimeoutError:
            import base64
            _PX1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
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
    from app.utils.cover_scrub import scrub_cover

    sb = get_supabase()
    _spaced = series.replace("-", " ")
    candidates = {
        series,
        _spaced,
        re.sub(r"\s+", "-", series),
        series.lower(),
        _spaced.lower(),
        re.sub(r"\s+", "-", series).lower(),
    }

    def _rank(u: str) -> int:
        u = (u or "").lower()
        if "assets.shngm.id" in u:
            return 0
        return 1

    _words = [w for w in _spaced.lower().split() if len(w) > 2][:4]
    _like = "%" + " ".join(_words[:3]) + "%" if _words else None
    all_covers: list[str] = []
    try:
        wl = sb.table("whitelist").select("cover").in_("title_key", list(candidates)).limit(5).execute()
        all_covers += [r["cover"] for r in (wl.data or []) if r.get("cover")]
        rc = sb.table("recent_chapters").select("cover").in_("title_key", list(candidates)).limit(10).execute()
        all_covers += [r["cover"] for r in (rc.data or []) if r.get("cover")]
        if _like and len(all_covers) < 2 and len(_like) >= 6:
            try:
                rc2 = sb.table("recent_chapters").select("cover, title_key").ilike("title_key", _like).limit(20).execute()
                all_covers += [r["cover"] for r in (rc2.data or []) if r.get("cover")]
            except Exception:
                pass
            try:
                wl2 = sb.table("whitelist").select("cover, title_key").ilike("title_key", _like).limit(10).execute()
                all_covers += [r["cover"] for r in (wl2.data or []) if r.get("cover")]
            except Exception:
                pass
    except Exception:
        pass
    seen: set[str] = set()
    ranked: list[str] = []
    for c in sorted(all_covers, key=_rank):
        if c not in seen:
            seen.add(c)
            ranked.append(c)
    for raw in ranked:
        cover_url = scrub_cover(raw)
        if not cover_url or not cover_url.startswith("http"):
            continue
        return await _fetch_image(cover_url, cache_control="public, max-age=3600")
    svg = '<svg width="200" height="280" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#444" font-size="12" font-family="sans-serif">No cover</text></svg>'
    return FastResponse(content=svg.encode(), status_code=200, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/reader/cover-img")
async def reader_cover_public(request: Request):
    from urllib.parse import unquote, urlparse

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
    from urllib.parse import unquote

    _guard = 0
    while re.search(r"%[0-9A-Fa-f]{2}", url) and not url.lower().startswith(("http://", "https://")) and _guard < 5:
        try:
            url = unquote(url)
        except Exception:
            break
        _guard += 1
    from urllib.parse import urlparse

    try:
        urlparse(url)
    except ValueError:
        return FastResponse(status_code=400)
    return await _fetch_image(url)


@router.get("/img")
async def img(request: Request):
    from urllib.parse import unquote, urlparse

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
