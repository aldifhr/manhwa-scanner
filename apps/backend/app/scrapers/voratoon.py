"""Voratoon scraper — https://v2.voratoon.com"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
import time
import random
import threading

from app.config import settings
from app.logger import get_logger
from app.utils.cover_scrub import scrub_cover
from app.services.resilience import cb_voratoon

logger = get_logger("scraper:voratoon")

def _base_url() -> str:
    return settings.VORATOON_API_URL.rstrip("/")
TIMEOUT = 60.0
_CLIENTS: dict[int, httpx.Client] = {}
_CLIENTS_LOCK = threading.Lock()


def _client() -> httpx.Client:
    key = threading.get_ident()
    with _CLIENTS_LOCK:
        return _CLIENTS.setdefault(key, httpx.Client(timeout=TIMEOUT))


def _get(url: str, **kwargs):
    return _client().get(url, **kwargs)


def _parse_chapter_number(index: int | None) -> float:
    try:
        return float(index) if index is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def fetch_series(page: int = 1, take: int = 50, fmt: str = "manhwa") -> list[dict]:
    """Fetch series list filtered by format (manhwa/manhua)."""
    url = f"{_base_url()}/series"
    params = {
        "take": take,
        "page": page,
        "sort": "latest",
        "sortOrder": "desc",
        "includeMeta": "true",
        "takeChapter": 0,
        "format": fmt,
    }
    if not cb_voratoon.allow():
        raise RuntimeError("circuit voratoon OPEN — fast fail")
    try:
        r = _get(url, params=params, timeout=TIMEOUT)
        r.raise_for_status()
        payload = r.json()
        data = payload.get("data")
        if not isinstance(data, list):
            raise RuntimeError("Voratoon series schema invalid")
        cb_voratoon.record_success()
        return data
    except Exception as e:
        cb_voratoon.record_failure()
        logger.error("voratoon series failed", exc=e)
        raise RuntimeError("Voratoon series fetch failed") from e


def fetch_series_detail(slug: str) -> dict | None:
    """Fetch single series detail with 5 latest chapters."""
    url = f"{_base_url()}/series/{slug}"
    params = {"includeMeta": "true", "takeChapter": 5}
    if not cb_voratoon.allow():
        raise RuntimeError("circuit voratoon OPEN — fast fail")
    try:
        r = _get(url, params=params, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json().get("data")
        if not isinstance(data, dict):
            raise RuntimeError("Voratoon detail schema invalid")
        cb_voratoon.record_success()
        return data
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return None
        cb_voratoon.record_failure()
        logger.error("voratoon detail failed", exc=e)
        raise RuntimeError("Voratoon detail fetch failed") from e
    except Exception as e:
        cb_voratoon.record_failure()
        logger.error("voratoon detail failed", exc=e)
        raise RuntimeError("Voratoon detail fetch failed") from e


def fetch_chapters(slug: str, page: int = 1, take: int = 100) -> list[dict]:
    """Fetch chapters for a series.

    NOTE: the per-series /series/{slug}/chapters endpoint returns chapters
    WITHOUT any publish timestamp (createdAt/updatedAt are absent). Prefer
    collect_voratoon()'s series-list-with-takeChapter path which includes
    real chapter timestamps.
    """
    url = f"{_base_url()}/series/{slug}/chapters"
    params = {"take": take, "page": page}
    import time as _t
    if not cb_voratoon.allow():
        raise RuntimeError("circuit voratoon OPEN — fast fail")
    try:
        for attempt in range(3):
            r = _get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 429:
                _t.sleep(2.0 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json().get("data")
            if not isinstance(data, list):
                raise RuntimeError("Voratoon chapters schema invalid")
            cb_voratoon.record_success()
            return data
        raise RuntimeError("Voratoon chapters retry exhausted")
    except Exception as e:
        cb_voratoon.record_failure()
        logger.error("voratoon chapters failed", exc=e)
        raise RuntimeError("Voratoon chapters fetch failed") from e


def _build_synopsis_cache() -> dict[str, str]:
    """Build a slug→synopsis cache from the series list (both formats)."""
    cache: dict[str, str] = {}
    for fmt in ("manhwa", "manhua"):
        page = 1
        while True:
            batch = fetch_series(page=page, take=100, fmt=fmt)
            if not batch:
                break
            for s in batch:
                data = s.get("data", {})
                slug = data.get("slug", "")
                synopsis = data.get("synopsis", "")
                if slug and synopsis:
                    cache[slug.lower()] = synopsis
            if len(batch) < 100:
                break
            page += 1
    return cache


def get_voratoon_synopsis(slug: str, title: str = "") -> str:
    """Get synopsis for a voratoon series — tries multiple lookup strategies."""
    # Strategy 1: Direct fetch by slug
    detail = fetch_series_detail(slug)
    if detail:
        data = detail.get("data", {})
        synopsis = data.get("synopsis", "")
        if synopsis:
            return synopsis

    # Strategy 2: Search in series list by slug
    cache = _build_synopsis_cache()
    slug_lower = slug.lower()
    if slug_lower in cache:
        return cache[slug_lower]

    # Strategy 3: Search by title (normalized)
    if title:
        title_lower = title.lower().strip()
        for s_slug, s_synopsis in cache.items():
            # Fetch the title for this slug
            s_detail = fetch_series_detail(s_slug)
            if s_detail:
                s_title = s_detail.get("data", {}).get("title", "").lower().strip()
                if s_title == title_lower:
                    return s_synopsis

    return ""


def collect_voratoon() -> list[dict]:
    """Collect recent chapters from Voratoon (manhwa + manhua).

    Uses the series endpoint with takeChapter=N + sort=latest (the shape the
    maintainer provided). A single paginated call returns both the series
    metadata AND its latest chapters WITH real publish timestamps
    (chapters[].createdAt / updatedAt) — unlike the per-series
    /series/{slug}/chapters endpoint, which returns chapters without any
    timestamp. We key updated_time off chapters[].createdAt so
    collect_recent_chapters doesn't drop every voratoon row (its old
    updated_time="" guard skipped them all, making voratoon never appear in
    RSS). This also replaces the old per-series loop (100 series x N chapter
    calls) with far fewer requests.
    """
    results: list[dict] = []

    # Latest releases: per format (manhwa=Korea, manhua=China), each with and
    # without the type==project filter (project-type series only appear under
    # the filter, so we need both). These 4 combos are independent paginations
    # — fetch them concurrently (PERF-05b) instead of serially to cut wall-clock.
    _combos = [
        ("manhwa", None),
        ("manhua", None),
        ("manhwa", "type==project"),
        ("manhua", "type==project"),
    ]

    def _fetch_combo(fmt: str, filt) -> list[dict]:
        """Paginate one format/filter combo and return its emitted chapters."""
        _out: list[dict] = []
        page = 1
        while True:
            url = f"{_base_url()}/series"
            params = {
                "take": 30,
                "page": page,
                "sort": "latest",
                "sortOrder": "desc",
                "includeMeta": "true",
                "takeChapter": 50,
                "format": fmt,
            }
            if filt:
                params["filter"] = filt
            # Retry loop with exponential backoff for 429
            payload = None
            for attempt in range(3):
                try:
                    r = _get(
                        url,
                        params=params,
                        timeout=TIMEOUT,
                        headers={"Accept-Encoding": "gzip, deflate"},
                    )
                    if r.status_code == 429:
                        retry_after = r.headers.get("retry-after")
                        wait = float(retry_after) if retry_after else (2 ** attempt + random.uniform(0, 1))
                        logger.debug("voratoon 429 rate limited", attempt=attempt, wait=round(wait, 2))
                        time.sleep(wait)
                        continue
                    r.raise_for_status()
                    payload = r.json()
                    break
                except Exception as e:
                    logger.error("voratoon series list failed", exc=e)
                    break
            if payload is None:
                break
            series_list = payload.get("data", [])
            if not series_list:
                break
            for s in series_list:
                _emit_series(_out, s)
            meta = payload.get("meta") or {}
            if meta.get("lastPage") and page >= int(meta["lastPage"]):
                break
            if len(series_list) < 30:
                break
            page += 1
        return _out

    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=len(_combos)) as _ex:
        for _combo_results in _ex.map(lambda c: _fetch_combo(*c), _combos):
            results.extend(_combo_results)

    logger.info("voratoon collect done", chapters=len(results))
    return results


def _emit_series(results: list[dict], s: dict) -> None:
    """Emit up to takeChapter recent chapters for one voratoon series dict."""
    data = s.get("data", {})
    slug = data.get("slug", "")
    title = data.get("title", "")
    if not slug:
        return
    # ponytail: filter JP — voratoon format manhwa(CN?)/manhua, skip manga/JP (format==manga or origin JP)
    _fmt = str(data.get("format") or "").lower()
    _orig_raw = str(data.get("origin") or data.get("country") or "").upper()
    if _fmt == "manga" or _fmt == "jp" or _orig_raw == "JP":
        return

    cover = data.get("coverImage", "")
    cover = scrub_cover(cover) if cover else ""
    synopsis = data.get("synopsis", "")
    rating = data.get("rating")
    genres = [g.get("data", {}).get("name", "") for g in data.get("genres", [])]
    fmt = data.get("format", "manhwa")
    # Fallback to per-series detail if rating or synopsis is missing from list endpoint
    if not rating or not synopsis:
        try:
            _detail = fetch_series_detail(slug)
            if _detail:
                _detail_data = _detail.get("data", {})
                rating = _detail_data.get("rating") or rating
                if not genres:
                    genres = [g.get("data", {}).get("name", "") for g in _detail_data.get("genres", [])]
                if not cover:
                    cover = _detail_data.get("coverImage", "")
                    cover = scrub_cover(cover) if cover else ""
                if not synopsis:
                    synopsis = _detail_data.get("synopsis", "")
        except Exception:
            pass

    for ch in (s.get("chapters") or []):
        ch_index = ch.get("chapterIndex") or ch.get("data", {}).get("index")
        if not ch_index:
            continue
        _created = ch.get("createdAt") or ch.get("updatedAt") or ""
        results.append({
            "title": title,
            "title_key": slug.lower(),
            "chapter": str(ch_index),
            "chapter_num": _parse_chapter_number(ch_index),
            "source": "voratoon",
            "cover": cover,
            "series_url": f"https://{settings.VORATOON_DOMAIN}/series/{slug}",
            "chapter_url": f"https://{settings.VORATOON_DOMAIN}/series/{slug}/chapter/{ch_index}",
            "description": synopsis[:500] if synopsis else "",
            "rating": float(rating) if rating else 0.0,
            "genres": genres,
            "type": fmt,
            "origin": "CN" if fmt == "manhua" else "KR" if fmt == "manhwa" else "", # ponytail: unknown fmt → "" not KR (was leaking voratoon CN→KR)
            "updated_time": _created,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
