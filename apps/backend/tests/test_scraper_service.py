"""Unit tests for app/services/scraper_service.py (mocked, no network)."""
import pytest
from unittest.mock import patch
from app.services.scraper_service import ScraperService


def test_collect_recent_chapters_dedupe():
    svc = ScraperService()
    with patch.object(svc, "_collect_ikiru", return_value=[
            {"title_key": "t a", "source": "ikiru", "chapter": "1"},
            {"title_key": "t a", "source": "ikiru", "chapter": "1"},  # dup
            {"title_key": "t a", "source": "ikiru", "chapter": "2"},
            {"title_key": "t a", "source": "ikiru", "chapter": "2"},  # dup
        ]), patch.object(svc, "_collect_shinigami", return_value=[
            {"title_key": "t b", "source": "shinigami", "chapter": "1"},
        ]):
        items, health = svc.collect_recent_chapters()
    assert len(items) == 3  # dedupe: t a ch1(ch1x2), t a ch2(ch2x2), t b ch1 -> 3 unique
    assert "ikiru" in health and "shinigami" in health  # health probe runs


def test_enrich_metadata_ikiru():
    svc = ScraperService()
    meta = {"cover": "x", "rating": 8.0, "genres": ["Action"], "description": "desc"}
    with patch("app.scrapers.ikiru.get_ikiru_series_meta", return_value=meta):
        out = svc.enrich_metadata("test manhwa", "ikiru", "https://07.ikiru.wtf/manga/test-manhwa/")
    assert out == {**meta, "source": "ikiru"}


def test_enrich_metadata_shinigami():
    svc = ScraperService()
    meta = {"cover": "y", "rating": 7.5, "genres": ["Drama"], "description": "d"}
    with patch("app.scrapers.shinigami.get_shinigami_series_meta", return_value=meta):
        out = svc.enrich_metadata("x", "shinigami", "https://11.shinigami.asia/series/abc123")
    assert out == {**meta, "source": "shinigami"}


def test_enrich_metadata_unknown_source():
    svc = ScraperService()
    assert svc.enrich_metadata("x", "unknown", "url") is None


def test_parse_num():
    from app.services.scraper_service import _parse_num
    assert _parse_num("Chapter 42") == 42.0
    assert _parse_num("no num") is None
    assert _parse_num("Vol.2 Ch.99") == 2.0
