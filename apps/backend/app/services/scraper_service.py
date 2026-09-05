"""Scraper service — facade over cron/collect (single source, was duplicate)."""
from __future__ import annotations

from types import SimpleNamespace

from app.logger import get_logger

logger = get_logger("services:scraper")


def collect_recent_chapters(hours: int = 24, max_pages: int = 10) -> tuple[list[dict], dict]:
    """Collect recent chapters — delegates to cron/collect.py canonical."""
    from app.cron.collect import collect_recent_chapters as _collect
    return _collect()

def enrich_metadata(title_key: str, source: str, series_url: str | None = None) -> dict | None:
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

# ponytail: class→functions + namespace (one instance only), restore class when need per-instance config
scraper_service = SimpleNamespace(collect_recent_chapters=collect_recent_chapters, enrich_metadata=enrich_metadata)
ScraperService = type("ScraperService", (), {"collect_recent_chapters": staticmethod(collect_recent_chapters), "enrich_metadata": staticmethod(enrich_metadata)})
