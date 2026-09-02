"""Observability / dashboard data API (formerly part of the compat layer).

Endpoints: notifications log, health-status, incidents, history, reader image
proxy, metrics.
"""
import time as _time
import re
import asyncio as _asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response as FastResponse
from datetime import datetime, timezone, timedelta

from app.config import settings
from app.logger import get_logger
from app.utils.request_auth import int_safe, safe_error, require_monitor_auth
from app.utils.cover_scrub import cover_ref

logger = get_logger("api:observability")
router = APIRouter()


# --- Health-status alias ---
APP_START_TS = _time.time()


def _fmt_uptime(seconds: float) -> str:
    s = int(seconds)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m"
    return f"{m}m {s}s"


@router.get("/health-status")
async def health_status(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase
    from app.storage import health as health_store
    datetime.now(timezone.utc)
    hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
    _api_ping = None
    for r in (hm or {}).values():
        rt = r.get("response_time_ms") or 0
        if rt and (_api_ping is None or rt < _api_ping):
            _api_ping = rt
    _sb_ping = None
    _disc_ping = None
    try:
        _sb_client = get_supabase()
        _t0 = _time.time()
        _sb_client.table("source_health").select("source").limit(1).execute()
        _sb_ping = int((_time.time() - _t0) * 1000)
    except Exception:
        _sb_ping = None
    try:
        from app.discord import client as _disc
        import httpx as _httpx
        _dt0 = _time.time()
        _tok = getattr(_disc, "TOKEN", None) or settings.DISCORD_BOT_TOKEN
        if _tok:
            with _httpx.Client(timeout=5) as _cx:
                _cx.get(
                    "https://discord.com/api/v10/gateway",
                    headers={"Authorization": f"Bot {_tok}"},
                )
            _disc_ping = int((_time.time() - _dt0) * 1000)
    except Exception:
        _disc_ping = None
    services = []
    for name in ("api", "discord", "supabase"):
        if name == "api":
            status = "healthy"
            ping = f"{_api_ping}ms" if _api_ping else None
        elif name == "discord":
            disc_ok = _disc_ping is not None
            status = "healthy" if disc_ok else "degraded"
            ping = f"{_disc_ping}ms" if _disc_ping else None
        else:
            status = "healthy"
            ping = f"{_sb_ping}ms" if _sb_ping else None
        services.append({
            "name": name,
            "status": status,
            "ping": ping,
            "uptime": _fmt_uptime(_time.time() - APP_START_TS) if name == "api" else None,
        })
    return JSONResponse(content={
        "success": True,
        "data": {
            "services": services,
            "uptime": _fmt_uptime(_time.time() - APP_START_TS),
            "sources": hm or {},
        },
    })


# --- History (recent chapters grouped) ---
@router.get("/history")
async def history(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    all_param = request.query_params.get("all") == "true"
    limit = 200 if all_param else 50
    try:
        res = (
            get_supabase()
            .table("recent_chapters")
            .select("*")
            .order("updated_time", desc=True)
            .limit(limit)
            .execute()
        )
        groups = {}
        for row in res.data or []:
            tk = row.get("title_key", "")
            if tk not in groups:
                groups[tk] = {
                    "title": row.get("title"),
                    "titleKey": tk,
                    "cover": cover_ref(tk),
                    "chapters": [],
                }
            ch_str = str(row.get("chapter") or "0")
            ch_num = int(re.sub(r"\D", "", ch_str) or 0)
            groups[tk]["chapters"].append({
                "chapterLabel": f"Ch. {row.get('chapter')}",
                "chapterNumber": ch_num,
                "url": row.get("chapter_url"),
                "source": row.get("source"),
                "sentAt": row.get("updated_time"),
            })
        return JSONResponse(content={"success": True, "data": {"results": list(groups.values())}})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


# --- Incidents (generated from real backend state) ---
@router.get("/incidents")
async def incidents(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    action = request.query_params.get("action", "")
    days_back = int_safe(request.query_params.get("days", "30"), 30, max_val=90)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days_back)).isoformat()
    now = datetime.now(timezone.utc)

    try:
        sb = get_supabase()
        timeline = []
        ongoing = []
        by_severity = {"critical": 0, "high": 0, "medium": 0, "low": 0}
        by_type = {}
        by_status = {"resolved": 0, "ongoing": 0}
        notices = []

        try:
            cron = (
                sb.table("cron_run_status")
                .select("status, created_at, duration, chapters_sent, matched")
                .gte("created_at", cutoff)
                .order("created_at", desc=True)
                .limit(200)
                .execute()
            )
            for row in cron.data or []:
                if row.get("status") != "ok":
                    ts = row.get("created_at", "")
                    dur = row.get("duration")
                    dur_s = f"{dur}s" if dur is not None else "unknown"
                    sent = row.get("chapters_sent")
                    timeline.append({"type": "Cron Failure", "message": f"Cron run failed (duration {dur_s}, sent {sent})", "timestamp": ts})
                    by_severity["high"] += 1
                    by_type["cron"] = by_type.get("cron", 0) + 1
                    by_status["ongoing"] += 1
                    ongoing.append({"type": "Cron Failure", "timestamp": ts})
        except Exception:
            pass

        try:
            fd = (
                sb.table("failed_dispatches")
                .select("chapter_url, source, error_message, created_at")
                .gte("created_at", cutoff)
                .order("created_at", desc=True)
                .limit(200)
                .execute()
            )
            for row in fd.data or []:
                ts = row.get("created_at", "")
                msg = f"Failed to notify {row.get('source', '?')} chapter: {row.get('error_message', 'unknown error')[:80]}"
                timeline.append({"type": "Dispatch Failure", "message": msg, "timestamp": ts})
                by_severity["critical"] += 1
                by_type["dispatch"] = by_type.get("dispatch", 0) + 1
                by_status["ongoing"] += 1
                ongoing.append({"type": "Dispatch Failure", "timestamp": ts})
                notices.append({"message": msg, "severity": "critical", "source": row.get("source", ""), "timestamp": ts})
        except Exception:
            pass

        try:
            sh = sb.table("source_health").select("*").execute()
            for row in sh.data or []:
                cf = row.get("consecutive_failures") or 0
                status = row.get("status", "healthy")
                src = row.get("source", "?")
                if status == "down" or cf >= 3:
                    by_severity["high"] += 1
                    by_type["source"] = by_type.get("source", 0) + 1
                    by_status["ongoing"] += 1
                    msg = f"Source '{src}' degraded: {cf} consecutive failures"
                    timeline.append({"type": "Source Degraded", "message": msg, "timestamp": row.get("last_checked_at", "")})
                    ongoing.append({"type": "Source Degraded", "timestamp": row.get("last_checked_at", "")})
                    notices.append({"message": msg, "severity": "high", "source": src, "timestamp": row.get("last_checked_at", "")})
                elif cf > 0:
                    by_severity["medium"] += 1
                    by_type["source"] = by_type.get("source", 0) + 1
                    notices.append({"message": f"Source '{src}': {cf} transient failures", "severity": "medium", "source": src, "timestamp": row.get("last_checked_at", "")})
        except Exception:
            pass

        if action == "notices":
            notice_cutoff = (now - timedelta(days=days_back)).isoformat()
            filtered = [n for n in notices if (n.get("timestamp") or "") >= notice_cutoff]
            return JSONResponse(content={
                "success": True,
                "data": {"notices": filtered, "totalNotices": len(filtered), "hasNotices": len(filtered) > 0, "days": days_back},
            })

        timeline.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        recent24h = sum(1 for t in timeline if t.get("timestamp", "") >= (now - timedelta(hours=24)).isoformat())
        resolved_count = max(0, len(timeline) - len(ongoing))

        return JSONResponse(content={
            "success": True,
            "data": {
                "results": timeline,
                "notices": notices,
                "total": len(timeline),
                "stats": {"byType": by_type, "bySeverity": by_severity, "byStatus": {"resolved": resolved_count, "ongoing": len(ongoing)}},
                "timeline": timeline,
                "daysBack": days_back,
                "totalCount": len(timeline),
                "recent24h": recent24h,
                "ongoingCount": len(ongoing),
            },
        })
    except Exception:
        return JSONResponse(content={
            "success": True,
            "data": {
                "results": [], "notices": [], "total": 0,
                "stats": {"byType": {}, "bySeverity": by_severity, "byStatus": {"resolved": 0, "ongoing": 0}},
                "timeline": [], "daysBack": days_back, "totalCount": 0, "recent24h": 0, "ongoingCount": 0,
            },
        })


# --- Image proxy ---
import httpx
import hashlib as _hashlib
import os as _os
import secrets as _secrets

# L2 NOTE: _RESPONSE_SIZE_CAP also defined in main.py — keep in sync
_RESPONSE_SIZE_CAP = 10 * 1024 * 1024  # 10MB

# SECURITY: unpredictable cache dir path — prevents symlink attacks and
# cache poisoning via predictable /tmp paths.
_image_cache_dir_env = _os.environ.get("IMAGE_CACHE_DIR")
if not _image_cache_dir_env:
    _image_cache_dir_env = _os.path.join(_os.sep, "tmp", f".be_ag_{_secrets.token_hex(8)}")
    _os.makedirs(_image_cache_dir_env, exist_ok=True)
_IMAGE_CACHE_DIR: str = _image_cache_dir_env
_IMAGE_CACHE_MAX = 2000
# Per-URL single-flight locks: prevent cache stampede when many <img>
# tags for the same cover fire in the same instant (fast scroll / initial
# grid paint). Without this, every concurrent miss hits the upstream
# (07.ikiru.wtf) at once → rate-limit 403s. With it, the first
# request fetches + writes the file; the rest await the same lock, then read
# the cached bytes.
_URL_FETCH_LOCKS: dict[str, "_asyncio.Lock"] = {}
_URL_LOCKS_GUARD = _asyncio.Lock()
# M2 FIX: Track last access time for lock eviction
_URL_FETCH_LOCKS_LAST_USED: dict[str, float] = {}
_URL_FETCH_LOCKS_MAX = 1000  # max concurrent URL locks before eviction


async def _url_lock(url: str):
    async with _URL_LOCKS_GUARD:
        if url not in _URL_FETCH_LOCKS:
            # M2 FIX: Evict oldest locks if we exceed max
            if len(_URL_FETCH_LOCKS) >= _URL_FETCH_LOCKS_MAX:
                _evict_oldest_locks()
            _URL_FETCH_LOCKS[url] = _asyncio.Lock()
        _URL_FETCH_LOCKS_LAST_USED[url] = _time.time()
    return _URL_FETCH_LOCKS[url]


def _evict_oldest_locks():
    """Evict least recently used URL locks."""
    if len(_URL_FETCH_LOCKS) < _URL_FETCH_LOCKS_MAX:
        return
    # Sort by last used, evict oldest 25%
    sorted_urls = sorted(_URL_FETCH_LOCKS_LAST_USED.items(), key=lambda x: x[1])
    to_evict = sorted_urls[:len(sorted_urls) // 4]
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
            # honour TTL so we don't serve stale covers forever
            if (_time.time() - _os.path.getmtime(p)) > max_age:
                return None
            _os.utime(p, None)
            with open(p, "rb") as f:
                return f.read()
    except Exception as e:
        # Cache read failures must be VISIBLE — a silently-swallowed
        # exception here previously hid a total cache outage (os.read on a
        # path instead of open()) for months. Never swallow; log + miss.
        logger.warn("cover cache get failed", url=url[:80], err=str(e)[:160])
        return None
    return None


def _cache_put(url: str, data: bytes) -> None:
    try:
        if _os.path.isdir(_IMAGE_CACHE_DIR):
            try:
                entries = [_os.path.join(_IMAGE_CACHE_DIR, f) for f in _os.listdir(_IMAGE_CACHE_DIR)]
                # TTL sweep: drop files older than 7 days (covers rotate)
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


@router.get("/reader/cover")
async def reader_cover(request: Request):
    """Authed cover endpoint (BE-3c/d).

    Returns the series cover image bytes WITHOUT exposing any S3/MinIO
    presigned URL in the API response. The client requests
    `/api/reader/cover?series=<slug>`; we resolve the real cover URL from
    the DB (whitelist, then recent_chapters), scrub any AWS presign query
    params, and proxy the image server-side. Short TTL cache headers.
    """
    if not require_monitor_auth(request):
        return FastResponse(status_code=401)
    series = (request.query_params.get("series", "") or "").strip()
    if not series or len(series) > 80:
        return FastResponse(status_code=400)
    # Basic slug sanity — block wildcard injection / path traversal
    if not re.match(r"^[a-zA-Z0-9\-_ ]+$", series):
        return FastResponse(status_code=400)
    from app.db import get_supabase
    from app.utils.cover_scrub import scrub_cover
    sb = get_supabase()
    # title_key is stored with SPACES in the DB ("genius blacksmith s game"),
    # but the FE passes dashed slugs ("genius-blacksmith-s-game"). Build all
    # plausible candidate keys so we match either form.
    import re as _re
    # DB title_key is messy: sometimes dashed ("absolute-dominion"), sometimes
    # spaced+lowercased ("the s classes that i raised"). Build every plausible
    # candidate so we match regardless of stored form.
    _spaced = series.replace("-", " ")
    candidates = {
        series,
        _spaced,
        _re.sub(r"\s+", "-", series),
        series.lower(),
        _spaced.lower(),
        _re.sub(r"\s+", "-", series).lower(),
    }
    # Prefer covers we can actually serve — assets.shngm.id first.
    def _rank(u: str) -> int:
        u = (u or "").lower()
        if "assets.shngm.id" in u:
            return 0
        return 1
    # A series may be stored under MULTIPLE title_key variants
    # (e.g. "the wandering knight s survival manual" vs the longer
    # "...how to survive as a wandering knight"). The FE passes one slug,
    # but the public-cover row may live under a SHORTER/DIFFERENT title_key.
    # So in addition to exact candidate keys, also match by prefix on the
    # leading significant words to pull in sibling rows.
    _words = [w for w in _spaced.lower().split() if len(w) > 2][:4]
    _like = "%" + " ".join(_words[:3]) + "%" if _words else None
    all_covers: list[str] = []
    try:
        wl = (
            sb.table("whitelist")
            .select("cover")
            .in_("title_key", list(candidates))
            .limit(5)
            .execute()
        )
        all_covers += [r["cover"] for r in (wl.data or []) if r.get("cover")]
        rc = (
            sb.table("recent_chapters")
            .select("cover")
            .in_("title_key", list(candidates))
            .limit(10)
            .execute()
        )
        all_covers += [r["cover"] for r in (rc.data or []) if r.get("cover")]
        # Broaden: only if exact candidates missed and pattern not too generic (avoid seq scan on "%a%")
        if _like and len(all_covers) < 2 and len(_like) >= 6:
            try:
                rc2 = (
                    sb.table("recent_chapters")
                    .select("cover, title_key")
                    .ilike("title_key", _like)
                    .limit(20)
                    .execute()
                )
                all_covers += [r["cover"] for r in (rc2.data or []) if r.get("cover")]
            except Exception:
                pass
            try:
                wl2 = (
                    sb.table("whitelist")
                    .select("cover, title_key")
                    .ilike("title_key", _like)
                    .limit(10)
                    .execute()
                )
                all_covers += [r["cover"] for r in (wl2.data or []) if r.get("cover")]
            except Exception:
                pass
    except Exception:
        pass
    # De-dup, prefer assets.shngm.id first.
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
        return await _proxy_url(cover_url)
    return FastResponse(status_code=404)


def _detect_ctype(data: bytes) -> str:
    """Best-effort image content-type from magic bytes."""
    if data[:4] == b"\x89PNG":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"GIF8":
        return "image/gif"
    return "image/jpeg"


async def _proxy_url(url: str) -> "FastResponse":
    """Fetch `url` (already SSRF-checked by caller) and return image bytes."""
    from urllib.parse import urlparse
    p = urlparse(url)
    allowed = getattr(settings, "PROXY_ALLOWED_HOSTS", []) or [
        "07.ikiru.wtf:443", "ikiru.wtf:443", "g.shinigami.asia:443",
        "shinigami.asia:443", "assets.shngm.id:443", "cvr.voratoon.id:443",
    ]
    host = (p.hostname or "").strip().lower()
    port = p.port or (443 if p.scheme == "https" else 80)
    host_port = f"{host}:{port}"
    # SECURITY: exact host:port match only — no wildcards, no port omission.
    # This prevents SSRF via DNS rebinding or non-standard ports.
    if p.scheme not in ("http", "https") or host_port not in allowed:
        return FastResponse(status_code=403)
    cached = _cache_get(url)
    if cached is not None:
        return FastResponse(
            content=cached, status_code=200, media_type=_detect_ctype(cached),
            headers={"Cache-Control": "public, max-age=3600", "X-Cache": "HIT"},
        )
    # Single-flight: the first concurrent request for this URL fetches +
    # writes the cache file; all others await the same lock, then read
    # the cached bytes. Prevents a cache stampede (200 <img> tags on
    # a fast scroll all missing at once → 200 parallel hits to
    # 07.ikiru.wtf → rate-limit 403s).
    lock = await _url_lock(url)
    async with lock:
        # re-check after acquiring the lock (another coroutine may have
        # populated the cache while we waited)
        cached = _cache_get(url)
        if cached is not None:
            return FastResponse(
                content=cached, status_code=200, media_type=_detect_ctype(cached),
                headers={"Cache-Control": "public, max-age=3600", "X-Cache": "HIT"},
            )
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                r = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; IkiruBot/1.0)"})
            if r.status_code == 200:
                # SECURITY: cap response size to prevent upstream from exhausting memory.
                content = r.content[:_RESPONSE_SIZE_CAP]
                _cache_put(url, content)
                ctype = r.headers.get("content-type") or _detect_ctype(content)
                return FastResponse(
                    content=content, status_code=200, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=3600", "X-Cache": "MISS"},
                )
            return FastResponse(status_code=r.status_code)
        except Exception:
            return FastResponse(status_code=502)


@router.get("/reader/cover-img")
async def reader_cover_public(request: Request):
    """Public (unauthenticated) cover-image proxy for Discord embeds."""
    from urllib.parse import unquote, urlparse

    raw_query = request.url.query or ""
    if raw_query.startswith("url="):
        url = raw_query[4:]
    else:
        url = request.query_params.get("url", "")
    url = (url or "").strip()
    if not url:
        return FastResponse(status_code=400)

    import re as _re
    _guard = 0
    while _re.search(r"%[0-9A-Fa-f]{2}", url) and not url.lower().startswith(("http://", "https://")) and _guard < 5:
        try:
            url = unquote(url)
        except Exception:
            break
        _guard += 1

    try:
        p = urlparse(url)
    except ValueError:
        return FastResponse(status_code=400)

    allowed = getattr(settings, "PROXY_ALLOWED_HOSTS", []) or [
        "07.ikiru.wtf:443", "ikiru.wtf:443", "g.shinigami.asia:443",
        "shinigami.asia:443", "assets.shngm.id:443", "cvr.voratoon.id:443",
    ]
    host = (p.hostname or "").strip().lower()
    port = p.port or (443 if p.scheme == "https" else 80)
    host_port = f"{host}:{port}"
    # DEBUG
    _scheme_ok = p.scheme in ("http", "https")
    _host_ok = host_port in allowed
    print(f"[cover-img] url={url[:60]} host_port={host_port} scheme_ok={_scheme_ok} host_ok={_host_ok} allowed_list={allowed}")
    if not _scheme_ok or not _host_ok:
        print(f"[cover-img] REJECTED: scheme={p.scheme} host_port={host_port}")
        return FastResponse(status_code=403)
    print("[cover-img] PASSED check, proceeding to fetch")

    cached = _cache_get(url)
    if cached is not None:
        return FastResponse(
            content=cached, status_code=200,
            media_type=_detect_ctype(cached),
            headers={"Cache-Control": "public, max-age=86400", "X-Cache": "HIT"},
        )
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; IkiruBot/1.0)"})
        print(f"[cover-img] Upstream status: {r.status_code}")
        if r.status_code == 200:
            content = r.content[:_RESPONSE_SIZE_CAP]
            _cache_put(url, content)
            ctype = r.headers.get("content-type") or _detect_ctype(content)
            return FastResponse(
                content=content, status_code=200, media_type=ctype,
                headers={"Cache-Control": "public, max-age=86400", "X-Cache": "MISS"},
            )
        return FastResponse(status_code=r.status_code)
    except Exception as e:
        print(f"[cover-img] Exception: {str(e)[:100]}")
        return FastResponse(status_code=502)


@router.get("/reader/proxy")
async def reader_proxy(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    # Reconstruct the full upstream URL. The FE forwards the RAW url
    # (which itself contains '&' query separators from MinIO presigned
    # signatures). Starlette's query_params.get('url') stops at the first
    # '&', silently dropping X-Amz-Date / X-Amz-Signature -> MinIO 403.
    # Recover the entire value from the raw query string instead.
    raw_query = request.url.query or ""
    if raw_query.startswith("url="):
        url = raw_query[4:]
    else:
        url = request.query_params.get("url", "")
    url = (url or "").strip()
    if not url:
        return FastResponse(status_code=400)
    # The FE may forward a still-percent-encoded URL (e.g. the raw
    # upstream was single-encoded by rewriteCoverUrl, then the browser
    # leaves it encoded in the query string). Decode once so urlparse()
    # sees a real scheme://host. Guard against double-decode of an
    # already-valid http(s) URL.
    import re as _re
    from urllib.parse import unquote
    _guard = 0
    while _re.search(r"%[0-9A-Fa-f]{2}", url) and not url.lower().startswith(("http://", "https://")) and _guard < 5:
        try:
            url = unquote(url)
        except Exception:
            break
        _guard += 1
    from urllib.parse import urlparse

    try:
        p = urlparse(url)
    except ValueError:
        return FastResponse(status_code=400)
    allowed = getattr(settings, "PROXY_ALLOWED_HOSTS", []) or [
        "07.ikiru.wtf:443", "ikiru.wtf:443", "g.shinigami.asia:443",
        "shinigami.asia:443", "assets.shngm.id:443", "cvr.voratoon.id:443",
    ]
    host = (p.hostname or "").strip().lower()
    port = p.port or (443 if p.scheme == "https" else 80)
    host_port = f"{host}:{port}"
    if p.scheme not in ("http", "https") or host_port not in allowed:
        return FastResponse(status_code=403)
    cached = _cache_get(url)
    if cached is not None:
        return FastResponse(
            content=cached, status_code=200,
            media_type=_detect_ctype(cached),
            headers={"Cache-Control": "public, max-age=86400", "Expires": "Thu, 31 Dec 2026 23:59:59 GMT", "X-Cache": "HIT"},
        )
    try:
        # Larger timeout so slow sources (ikiru) finish instead of Discord
        # aborting the fetch (Discord's media proxy times out at ~3-5s). We buffer
        # once, cache it, and serve from cache on every subsequent request — so
        # Discord's retry (or its CDN) gets an instant 200 from our cache.
        # SECURITY: cap response size to prevent upstream from exhausting memory.
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
            r = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; IkiruBot/1.0)"},
            )
        if r.status_code == 200:
            content = r.content[:_RESPONSE_SIZE_CAP]
            _cache_put(url, content)
            ctype = r.headers.get("content-type") or _detect_ctype(content)
            return FastResponse(
                content=content,
                status_code=200,
                media_type=ctype,
                headers={"Cache-Control": "public, max-age=86400", "Expires": "Thu, 31 Dec 2026 23:59:59 GMT", "X-Cache": "MISS"},
            )
        return FastResponse(status_code=r.status_code)
    except Exception:
        return FastResponse(status_code=502)


# --- Metrics (internal-only: counts per table) ---
# Canonical JSON metrics is GET /api/metrics in app/api/system.py (cron-gated).
# This alias is kept for backward compat (monitor-gated); both return same shape
# but system.py is preferred. Prometheus scrapes GET /metrics (open).
@router.get("/metrics")
@router.get("/internal/metrics")
async def metrics_observability(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    try:
        sb = get_supabase()
        def _count(table: str) -> int:
            try:
                return sb.table(table).select("*", count="exact").execute().count or 0
            except Exception:
                return -1
        data = {
            "whitelist": _count("whitelist"),
            "recent_chapters": _count("recent_chapters"),
            "dispatch_history": _count("dispatch_history"),
            "failed_dispatches": _count("failed_dispatches"),
            "cron_run_status": _count("cron_run_status"),
            "source_health": _count("source_health"),
        }
        # merge lightweight process counters (errors_500 etc.) for unified view
        try:
            from app.metrics import snapshot as _snap
            data["counters"] = _snap().get("counters", {})
        except Exception:
            pass
        return JSONResponse(content={"success": True, "data": data})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)
