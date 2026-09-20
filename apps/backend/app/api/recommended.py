"""Recommended / Popular — GET /recommended (public).

Aggregates Shinigami top daily + Voratoon popular into a single feed for
the home hero. No DB, no auth — pure upstream fan-out with 5-min cache.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.logger import get_logger
from app.utils.cover_scrub import scrub_cover

logger = get_logger("api:recommended")
router = APIRouter()

_CACHE: dict[str, tuple[float, dict]] = {}
_TTL = 300.0  # 5 min


def _shinigami_series_url(manga_id: str) -> str:
    base = (settings.SHINIGAMI_PUBLIC_BASE or settings.SHINIGAMI_PUBLIC_URL or "https://11.shinigami.asia").rstrip("/")
    return f"{base}/series/{manga_id}"


def _voratoon_series_url(slug: str) -> str:
    return f"https://{settings.VORATOON_DOMAIN}/series/{slug}"


def _fetch_shinigami(limit: int = 10) -> list[dict[str, Any]]:
    try:
        from curl_cffi import requests as cffi_req

        url = f"{settings.SHINIGAMI_API_BASE.rstrip('/')}/v1/manga/top"
        params = {"filter": "daily", "page": 1, "page_size": limit}
        r = cffi_req.get(url, params=params, impersonate="chrome", timeout=15)
        if r.status_code != 200:
            logger.warn("shinigami top failed", status=r.status_code)
            return []
        j = r.json()
        out: list[dict[str, Any]] = []
        for d in (j.get("data") or [])[:limit]:
            cover = d.get("cover_image_url") or d.get("cover_portrait_url") or ""
            if cover:
                cover = scrub_cover(cover) or cover
            slug = d.get("manga_id") or ""
            # extract genres from taxonomy if present
            genres = []
            tax = d.get("taxonomy") or {}
            for g in (tax.get("Genre") or []):
                if g.get("name"):
                    genres.append(g["name"])
            out.append({
                "title": d.get("title") or "",
                "titleKey": slug,
                "slug": slug,
                "cover": cover,
                "seriesUrl": _shinigami_series_url(slug) if slug else "",
                "source": "shinigami",
                "rating": float(d.get("user_rate") or 0) or None,
                "views": int(d.get("view_count") or 0),
                "bookmarks": int(d.get("bookmark_count") or 0),
                "genres": genres,
                "description": (d.get("description") or "")[:300],
                "latestChapter": str(d.get("latest_chapter_number") or ""),
                "type": "manhwa",
                "origin": d.get("country_id") or "KR",
                "rank": d.get("rank"),
            })
        return out
    except Exception as e:
        logger.warn("shinigami fetch error", err=str(e)[:160])
        return []


def _fetch_shinigami_manhua(limit: int = 10) -> list[dict[str, Any]]:
    """Shinigami recommended manhua — /v1/manga/list?format=manhua&is_recommended=true."""
    try:
        from curl_cffi import requests as cffi_req

        url = f"{settings.SHINIGAMI_API_BASE.rstrip('/')}/v1/manga/list"
        params = {
            "format": "manhua",
            "page": 1,
            "page_size": limit,
            "is_recommended": "true",
            "sort": "latest",
            "sort_order": "desc",
        }
        r = cffi_req.get(url, params=params, impersonate="chrome", timeout=15)
        if r.status_code != 200:
            logger.warn("shinigami manhua rec failed", status=r.status_code)
            return []
        j = r.json()
        out: list[dict[str, Any]] = []
        for d in (j.get("data") or [])[:limit]:
            cover = d.get("cover_image_url") or d.get("cover_portrait_url") or ""
            if cover:
                cover = scrub_cover(cover) or cover
            slug = d.get("manga_id") or ""
            genres = []
            tax = d.get("taxonomy") or {}
            for g in (tax.get("Genre") or []):
                if g.get("name"):
                    genres.append(g["name"])
            out.append({
                "title": d.get("title") or "",
                "titleKey": slug,
                "slug": slug,
                "cover": cover,
                "seriesUrl": _shinigami_series_url(slug) if slug else "",
                "source": "shinigami",
                "subSource": "manhua",
                "rating": float(d.get("user_rate") or 0) or None,
                "views": int(d.get("view_count") or 0),
                "bookmarks": int(d.get("bookmark_count") or 0),
                "genres": genres,
                "description": (d.get("description") or "")[:300],
                "latestChapter": str(d.get("latest_chapter_number") or ""),
                "type": "manhua",
                "origin": d.get("country_id") or "CN",
                "rank": d.get("rank"),
                "isRecommended": bool(d.get("is_recommended")),
            })
        return out
    except Exception as e:
        logger.warn("shinigami manhua fetch error", err=str(e)[:160])
        return []


def _fetch_voratoon(limit: int = 10) -> list[dict[str, Any]]:
    try:
        import httpx

        url = f"{settings.VORATOON_API_URL.rstrip('/')}/series"
        params = {
            "take": str(limit),
            "page": "1",
            "includeMeta": "true",
            "sort": "popularity",
            "sortOrder": "desc",
        }
        with httpx.Client(timeout=15.0) as c:
            r = c.get(url, params=params, headers={"Accept": "application/json"})
            if r.status_code != 200:
                logger.warn("voratoon popular failed", status=r.status_code)
                return []
            j = r.json()
        out: list[dict[str, Any]] = []
        for s in (j.get("data") or [])[:limit]:
            data = s.get("data") or {}
            slug = data.get("slug") or ""
            if not slug:
                continue
            cover = data.get("coverImage") or ""
            if cover:
                # voratoon cover is presigned cvr.voratoon.id — must go through proxy
                cover = scrub_cover(cover) or cover
            genres = [g.get("data", {}).get("name", "") for g in (data.get("genres") or []) if g.get("data", {}).get("name")]
            out.append({
                "title": data.get("title") or "",
                "titleKey": slug,
                "slug": slug,
                "cover": cover,
                "seriesUrl": _voratoon_series_url(slug),
                "source": "voratoon",
                "rating": float(data.get("rating") or 0) or None,
                "views": int(str(data.get("totalViews") or "0").replace(",", "") or 0),
                "bookmarks": int(str(data.get("bookmarkCount") or "0") or 0),
                "genres": genres,
                "description": (data.get("synopsis") or "")[:300],
                "latestChapter": str(data.get("totalChapters") or ""),
                "type": data.get("format") or "manhwa",
                "origin": "CN" if (data.get("format") or "").lower() == "manhua" else "KR",
                "isRecommended": bool(data.get("isRecommended")),
            })
        return out
    except Exception as e:
        logger.warn("voratoon fetch error", err=str(e)[:160])
        return []


async def _fetch_all(limit: int) -> list[dict[str, Any]]:
    sh, sh_manhua, vo = await asyncio.gather(
        asyncio.to_thread(_fetch_shinigami, limit),
        asyncio.to_thread(_fetch_shinigami_manhua, limit),
        asyncio.to_thread(_fetch_voratoon, limit),
    )
    # round-robin 3 sources: daily top, manhua rec, voratoon popular
    merged: list[dict[str, Any]] = []
    for i in range(max(len(sh), len(sh_manhua), len(vo))):
        if i < len(sh):
            merged.append(sh[i])
        if i < len(sh_manhua):
            merged.append(sh_manhua[i])
        if i < len(vo):
            merged.append(vo[i])
    # dedup by titleKey (shinigami daily vs manhua may overlap)
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for it in merged:
        k = it.get("titleKey") or it.get("slug") or ""
        if k and k in seen:
            continue
        if k:
            seen.add(k)
        deduped.append(it)
    return deduped[: limit * 3]


@router.get("/recommended")
async def recommended(request: Request):
    # public — no auth
    raw_limit = request.query_params.get("limit", "10")
    try:
        limit = max(1, min(30, int(raw_limit)))
    except Exception:
        limit = 10
    cache_key = f"rec:{limit}"
    now = time.monotonic()
    cached = _CACHE.get(cache_key)
    if cached and (now - cached[0]) < _TTL:
        return JSONResponse(content=cached[1], headers={"Cache-Control": "public, max-age=60, stale-while-revalidate=300", "X-Cache": "HIT"})

    results = await _fetch_all(limit)
    body = {"success": True, "data": {"results": results, "total": len(results)}}
    _CACHE[cache_key] = (now, body)
    # prune
    if len(_CACHE) > 20:
        oldest = sorted(_CACHE.items(), key=lambda kv: kv[1][0])[:10]
        for k, _ in oldest:
            _CACHE.pop(k, None)
    return JSONResponse(content=body, headers={"Cache-Control": "public, max-age=60, stale-while-revalidate=300", "X-Cache": "MISS"})
