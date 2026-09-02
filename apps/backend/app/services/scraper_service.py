"""Scraper service — consolidates ikiru + shinigami scraping logic.

Replaces scattered enrichment in collect.py, whitelist.py, enrich_whitelist.py.
"""
from __future__ import annotations

import re

from app.logger import get_logger
from app.scrapers import ikiru, shinigami
from app.services.resilience import retry_with_backoff, with_circuit_breaker, cb_ikiru, cb_shinigami

logger = get_logger("services:scraper")


class ScraperService:
    """Unified interface for scraping chapters from all sources."""

    def collect_recent_chapters(self, hours: int = 24, max_pages: int = 10) -> tuple[list[dict], dict]:
        """Collect recent chapters from both sources. Returns (items, health)."""
        from app.config import settings
        from curl_cffi import requests as cffi_req
        import time as _t

        health = {}

        # Health probe
        for src, url in [("ikiru", settings.IKIRU_BASE_URL), ("shinigami", settings.SECONDARY_SOURCE_URL + "/v1/manga/list?page=1&page_size=1&is_update=true&sort=latest")]:
            try:
                start = _t.monotonic()
                r = cffi_req.get(str(url).rstrip("/") + "/", impersonate="chrome", timeout=10) if src == "ikiru" else cffi_req.get(url, timeout=10)
                health[src] = {"status": r.status_code, "rt_ms": round((_t.monotonic() - start) * 1000), "ok": r.status_code == 200}
            except Exception as e:
                health[src] = {"status": 0, "rt_ms": 0, "ok": False, "error": str(e)[:80]}

        # Collect from ikiru
        ikiru_items = self._collect_ikiru(max_pages)

        # Collect from shinigami
        shinigami_items = self._collect_shinigami(max_pages)

        all_items = ikiru_items + shinigami_items

        # Dedupe by title_key + source + chapter
        seen = set()
        deduped = []
        for it in all_items:
            key = (it.get("title_key", ""), it.get("source", ""), str(it.get("chapter", "")))
            if key not in seen:
                seen.add(key)
                deduped.append(it)

        return deduped, health

    @with_circuit_breaker(cb_ikiru)
    @retry_with_backoff(max_retries=3, base_delay=0.5, max_delay=5.0)
    def _collect_ikiru(self, max_pages: int = 10) -> list[dict]:
        """Collect from ikiru API."""
        items = []
        for page in range(1, max_pages + 1):
            data = ikiru._fetch_json(f"/list/latest?page={page}&per_page=50")
            if not data or not data.get("ok"):
                break
            for item in data.get("items", []):
                title = item.get("title", "").strip()
                slug = item.get("slug", "")
                permalink = item.get("permalink", "")
                cover = item.get("cover", "")
                modified = item.get("modified_gmt", "")

                for ch in (item.get("latest_chapters") or []):
                    ch_title = ch.get("title", f"Chapter {ch.get('number', '?')}")
                    ch_num = ch.get("number")
                    items.append({
                        "title_key": slug.replace("-", " "),
                        "title": title,
                        "slug": slug,
                        "chapter": ch_title,
                        "chapter_num": ch_num if ch_num is not None else _parse_num(ch_title),
                        "chapter_url": f"{settings.IKIRU_BASE_URL.rstrip(chr(47))}/manga/{slug}/chapter-{ch_num}/" if slug and ch_num else "",
                        "source": "ikiru",
                        "cover": cover,
                        "series_url": permalink or f"{settings.IKIRU_BASE_URL.rstrip(chr(47))}/manga/{slug}/",
                        "origin": "KR",
                        "updated_time": modified,
                        "created_at": modified,
                    })
            if not data.get("items"):
                break
        return items

    @with_circuit_breaker(cb_shinigami)
    @retry_with_backoff(max_retries=3, base_delay=0.5, max_delay=5.0)
    def _collect_shinigami(self, max_pages: int = 10) -> list[dict]:
        """Collect from shinigami API."""
        items = []
        try:
            for mtype in ("mirror", "project"):
                for page in range(1, max_pages + 1):
                    data = shinigami._get(f"/manga/list?type={mtype}&page={page}&page_size=100&is_update=true&sort=latest&sort_order=desc")
                    api_items = data.get("data", []) if data else []
                    if not api_items:
                        break
                    for item in api_items:
                        mid = item.get("manga_id", "")
                        title = item.get("title", "").strip()
                        slug = item.get("slug", mid)
                        permalink = item.get("permalink", f"https://11.shinigami.asia/series/{mid}")
                        cover = item.get("cover_image_url", item.get("cover_portrait_url", ""))
                        modified = item.get("latest_chapter_time", item.get("updated_at", ""))

                        for ch in (item.get("latest_chapters") or []):
                            ch_title = ch.get("title", f"Chapter {ch.get('number', '?')}")
                            ch_num = ch.get("number")
                            items.append({
                                "title_key": title.lower(),
                                "title": title,
                                "slug": slug,
                                "chapter": ch_title,
                                "chapter_num": ch_num if ch_num is not None else _parse_num(ch_title),
                                "chapter_url": f"https://11.shinigami.asia/chapter/{ch.get('id', '')}/" if ch.get("id") else "",
                                "source": "shinigami",
                                "cover": cover,
                                "series_url": permalink,
                                "origin": item.get("country_id", ""),
                                "updated_time": modified,
                                "created_at": modified,
                            })
        except Exception as e:
            logger.warn("shinigami collection failed", err=str(e)[:120])
        return items

    def enrich_metadata(self, title_key: str, source: str, series_url: str | None = None) -> dict | None:
        """Fetch metadata from source API."""
        if source == "ikiru":
            slug = None
            if series_url and "/manga/" in series_url:
                slug = series_url.split("/manga/")[-1].strip("/").split("/")[0]
            if not slug:
                from app.utils.text import ikiru_slug
                slug = ikiru_slug(title_key)
            meta = ikiru.get_ikiru_series_meta(slug)
            if meta:
                return {**meta, "source": "ikiru"}
        elif source == "shinigami":
            mid = None
            if series_url and "shinigami.asia/series/" in series_url:
                mid = series_url.rstrip("/").split("/")[-1]
            if not mid:
                return None
            meta = shinigami.get_shinigami_series_meta(mid)
            if meta:
                return {**meta, "source": "shinigami"}
        return None


def _parse_num(ch: str) -> float | None:
    """Parse chapter number from string."""
    m = re.search(r"(\d+(?:\.\d+)?)", str(ch))
    return float(m.group(1)) if m else None


# Singleton
scraper_service = ScraperService()
