"""Kiryuu scraper module — curl_cffi for Cloudflare bypass."""

from curl_cffi import requests as cffi_req

from app.config import settings
from app.logger import get_logger

logger = get_logger("scraper:kiryuu")

API_BASE = settings.KIRYUU_PUBLIC_URL.rstrip("/")


def _fetch(url: str, timeout: float = 10) -> cffi_req.Response:
    return cffi_req.get(url, impersonate="chrome", timeout=timeout)


def fetch_latest_updates(page: int = 1, per_page: int = 32) -> list[dict]:
    """Fetch latest chapter updates from Kiryuu v7."""
    try:
        url = f"{API_BASE}/api/v1/chapters?page={page}&per_page={per_page}"
        r = _fetch(url)
        if r.status_code != 200:
            logger.warn("kiryuu fetch failed", status=r.status_code)
            return []
        data = r.json()
        return data.get("data", data if isinstance(data, list) else [])
    except Exception as e:
        logger.warn("kiryuu fetch error", error=str(e)[:120])
        return []


def series_url(slug: str) -> str:
    return f"{API_BASE}/manga/{slug}/"


def chapter_url(slug: str, chapter_num: int | float, ch_id: str | None = None) -> str:
    num = str(chapter_num).replace(".5", "-half")
    return f"{API_BASE}/manga/{slug}/chapter-{num}/"
