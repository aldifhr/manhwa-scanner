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
    from app.utils.ssrf import assert_allowed_url
    _b = settings.VORATOON_API_URL.rstrip("/")
    assert_allowed_url(_b)
    return _b
TIMEOUT = 30.0
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
    for _attempt in range(3):
        try:
            r = _get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 429:
                _wait = float(r.headers.get("retry-after", 2 ** _attempt)) if r.headers.get("retry-after") else (2 ** _attempt + random.uniform(0, 1))
                logger.debug("voratoon detail 429 retry", slug=slug, attempt=_attempt, wait=round(_wait, 2))
                time.sleep(_wait)
                continue
            r.raise_for_status()
            data = r.json().get("data")
            if not isinstance(data, dict):
                raise RuntimeError("Voratoon detail schema invalid")
            cb_voratoon.record_success()
            return data
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                logger.debug("voratoon detail 404", slug=slug, status=404)
                return None
            if e.response.status_code == 429 and _attempt < 2:
                _wait = float(e.response.headers.get("retry-after", 2 ** _attempt)) if e.response.headers.get("retry-after") else (2 ** _attempt + random.uniform(0, 1))
                logger.debug("voratoon detail 429 HTTPStatus retry", slug=slug, attempt=_attempt, wait=round(_wait, 2))
                time.sleep(_wait)
                continue
            cb_voratoon.record_failure()
            logger.error("voratoon detail failed", slug=slug, status=e.response.status_code if e.response else 0, url=url, exc=e)
            raise RuntimeError("Voratoon detail fetch failed") from e
        except Exception as e:
            if "429" in str(e).lower() and _attempt < 2:
                _wait = 2 ** _attempt + random.uniform(0, 1)
                logger.debug("voratoon detail 429 exception retry", slug=slug, attempt=_attempt, wait=round(_wait, 2))
                time.sleep(_wait)
                continue
            cb_voratoon.record_failure()
            logger.error("voratoon detail failed", slug=slug, url=url, exc=e)
            raise RuntimeError("Voratoon detail fetch failed") from e
    cb_voratoon.record_failure()
    logger.error("voratoon detail failed after retries", slug=slug, url=url)
    raise RuntimeError("Voratoon detail fetch failed after retries")

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

from app.scrapers.voratoon.feed import VoratoonFeed, _emit_series  # noqa: F401 — re-export for compat

def collect_voratoon() -> list[dict]:
    """Compat shim — use VoratoonFeed(window=24).collect() directly."""
    return VoratoonFeed(window_hours=24).collect()
