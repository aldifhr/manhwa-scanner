"""Scraper service — facade over cron/collect (single source, was duplicate).

Previously this file duplicated collect_recent_chapters with a simplified
_collect_ikiru/_collect_shinigami that missed voratoon, gap-fill, re-touch
guards and health telemetry. Now it delegates to cron/collect.py canonical
implementation so pipeline has ONE source of truth.
"""
from __future__ import annotations

from app.logger import get_logger

logger = get_logger("services:scraper")


class ScraperService:
    """Unified interface for scraping chapters from all sources (facade)."""

    def collect_recent_chapters(self, hours: int = 24, max_pages: int = 10) -> tuple[list[dict], dict]:
        """Collect recent chapters — delegates to cron/collect.py canonical."""
        from app.cron.collect import collect_recent_chapters as _collect

        # hours/max_pages kept for compat but cron/collect uses 24h window internally
        return _collect()

    def enrich_metadata(self, title_key: str, source: str, series_url: str | None = None) -> dict | None:
        """Fetch metadata from source API (still via scrapers, not collect)."""
        from app.scrapers import ikiru, shinigami

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


# Singleton
scraper_service = ScraperService()
