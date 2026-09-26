"""Komiku API — latest updates fetch."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("scraper:komiku")

API_BASE = "https://01.komiku.asia/api/v2"


def _get(url: str, params: dict | None = None) -> Any:
    """HTTP GET with curl_cffi fallback for Cloudflare TLS fingerprint block."""
    import httpx

    try:
        with httpx.Client(timeout=15) as c:
            r = c.get(url, params=params, timeout=15)
            if r.status_code == 200:
                return r.json()
            logger.debug("komiku httpx non-200", status=r.status_code)
    except Exception as e:
        logger.debug("komiku httpx failed", err=str(e)[:120])

    # Fallback: curl_cffi (impersonate="chrome") bypasses CF TLS fingerprint block
    from curl_cffi import requests as cffi_req

    r = cffi_req.get(url, params=params, impersonate="chrome", timeout=15)
    return r.json()


def fetch_latest_updates(page: int = 1, per_page: int = 32) -> list[dict[str, Any]]:
    """Fetch latest updates from Komiku API.

    Returns list of items, each with comic info + chapters.
    """
    url = f"{API_BASE}/comics/latest-updates"
    params = {"page": page, "perPage": per_page}

    try:
        data = _get(url, params)
        if isinstance(data, dict):
            return data.get("items", [])
        if isinstance(data, list):
            return data
        return []
    except Exception as exc:
        logger.warning("komiku fetch error", err=str(exc)[:160])
        return []


def series_url(slug: str) -> str:
    return f"https://01.komiku.asia/manga/{slug}"


def chapter_url(slug: str, chapter_num: int, chapter_id: int | None = None) -> str:
    if chapter_id:
        return f"https://01.komiku.asia/read/id/{slug}/ch{chapter_num}-{chapter_id}"
    return f"https://01.komiku.asia/read/id/{slug}/ch{chapter_num}"
