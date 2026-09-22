"""Voratoon scraper — https://v2.voratoon.com"""
from __future__ import annotations

from datetime import datetime, timezone

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

TIMEOUT = 90.0
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}
_cf_client_lock = threading.Lock()
_cf_client = None


def _get(url: str, **kwargs):
    global _cf_client
    with _cf_client_lock:
        if _cf_client is None:
            from curl_cffi import requests as cffi_req
            _cf_client = cffi_req.Session()
    from curl_cffi import requests as cffi_req
    return _cf_client.get(
        url, headers=_HEADERS, impersonate="chrome",
        timeout=kwargs.get("timeout", TIMEOUT), allow_redirects=True
    )


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
            if r.status_code == 403:
                logger.debug("voratoon detail 403 — Cloudflare WAF block", slug=slug, attempt=_attempt)
                return None
            if r.status_code >= 400:
                raise RuntimeError(f"HTTP {r.status_code}")
            data = r.json().get("data")
            if not isinstance(data, dict):
                raise RuntimeError("Voratoon detail schema invalid")
            cb_voratoon.record_success()
            return data
        except Exception as e:
            if "429" in str(e).lower() and _attempt < 2:
                _wait = 2 ** _attempt + random.uniform(0, 1)
                logger.debug("voratoon detail 429 exception retry", slug=slug, attempt=_attempt, wait=round(_wait, 2))
                time.sleep(_wait)
                continue
            if "403" in str(e).lower():
                logger.debug("voratoon detail 403 — Cloudflare WAF block (exception)", slug=slug, exc=e)
                return None
            cb_voratoon.record_failure()
            logger.error("voratoon detail failed", slug=slug, exc=e)
            raise RuntimeError("Voratoon detail fetch failed") from e
    return None


def fetch_chapters(slug: str, page: int = 1, take: int = 50) -> list[dict]:
    """Fetch chapters for a series."""
    url = f"{_base_url()}/series/{slug}/chapters"
    params = {"take": take, "page": page}
    if not cb_voratoon.allow():
        raise RuntimeError("circuit voratoon OPEN — fast fail")
    try:
        for attempt in range(3):
            r = _get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 429:
                time.sleep(2.0 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"HTTP {r.status_code}")
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
        if not cb_voratoon.allow():
            logger.warn("voratoon synopsis: circuit OPEN, skipping", fmt=fmt)
            break
        page = 1
        while True:
            batch = fetch_series(page=page, take=50, fmt=fmt)
            if not batch:
                break
            for s in batch:
                data = s.get("data", {})
                slug = data.get("slug", "")
                synopsis = data.get("synopsis", "")
                if slug and synopsis:
                    cache[slug.lower()] = synopsis
            if len(batch) < 50:
                break
            page += 1
    return cache


def get_voratoon_synopsis(slug: str, title: str = "") -> str:
    """Get synopsis for a voratoon series — tries multiple lookup strategies."""
    detail = fetch_series_detail(slug)
    if detail:
        data = detail.get("data", {})
        synopsis = data.get("synopsis", "")
        if synopsis:
            return synopsis
    cache = _build_synopsis_cache()
    slug_lower = slug.lower()
    if slug_lower in cache:
        return cache[slug_lower]
    return ""


from app.scrapers.voratoon.feed import VoratoonFeed  # noqa: F401 — re-export for compat


def collect_voratoon() -> list[dict]:
    """Compat shim — use VoratoonFeed(window=24).collect() directly."""
    return VoratoonFeed(window_hours=24).collect()
