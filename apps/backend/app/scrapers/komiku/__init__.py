"""Komiku API — latest updates fetch."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("scraper:komiku")

API_BASE = "https://01.komiku.asia/api/v2"


def fetch_latest_updates(page: int = 1, per_page: int = 32) -> list[dict[str, Any]]:
    """Fetch latest updates from Komiku API.

    Returns list of items, each with comic info + chapters.
    """
    import httpx

    url = f"{API_BASE}/comics/latest-updates"
    params = {"page": page, "perPage": per_page}

    try:
        with httpx.Client(timeout=15) as c:
            r = c.get(url, params=params)
            if r.status_code != 200:
                logger.warning("komiku fetch failed", status=r.status_code)
                return []
            data = r.json()
            return data.get("items", [])
    except Exception as exc:
        logger.warning("komiku fetch error", err=str(exc)[:160])
        return []


def series_url(slug: str) -> str:
    return f"https://01.komiku.asia/{slug}"


def chapter_url(slug: str, chapter_num: int) -> str:
    return f"https://01.komiku.asia/{slug}/chapter-{chapter_num}"
