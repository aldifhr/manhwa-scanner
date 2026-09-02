"""Unit tests for app/services/pipeline_service.py (mocked)."""
import pytest
from unittest.mock import patch, MagicMock
from app.services.pipeline_service import PipelineService


def test_run_dispatch_end_to_end():
    svc = PipelineService()
    items = [{
        "title": "Example Series", "title_key": "example series", "source": "shinigami",
        "chapter": "99", "url": "https://x/99", "chapter_url": "https://x/99",
        "cover": "", "series_url": "s", "status": "", "rating": "", "genres": [], "description": "", "updated_time": "",
    }]
    with patch.object(svc.scraper_service, "collect_recent_chapters", return_value=(items, {})), \
         patch.object(svc.dispatch_service, "get_target_channels", return_value=["chan1"]), \
         patch.object(svc.dispatch_service, "get_claimed_keys", return_value=set()), \
         patch("app.db.get_supabase") as gs, \
         patch.object(svc.dispatch_service, "send_chapter", return_value=True) as send:
        # mock whitelist query (title_key, source)
        wl_res = MagicMock(); wl_res.data = [{"title_key": "example series", "source": "shinigami"}]
        gs.return_value.table.return_value.select.return_value.execute.return_value = wl_res
        stats = svc.run_dispatch()
    assert stats["sent"] >= 1
    assert stats["matched"] == 1
    send.assert_called()


def test_run_rss_fetch():
    svc = PipelineService()
    with patch.object(svc.scraper_service, "collect_recent_chapters", return_value=([1, 2, 3], {})):
        stats = svc.run_rss_fetch()
    assert stats["fetched"] == 3


def test_empty_items():
    svc = PipelineService()
    with patch.object(svc.scraper_service, "collect_recent_chapters", return_value=([], {})):
        stats = svc.run_dispatch()
    assert stats["sent"] == 0
    assert stats["matched"] == 0


def test_no_channels():
    svc = PipelineService()
    items = [{"title": "X", "title_key": "x", "source": "ikiru", "chapter": "1",
              "url": "u", "chapter_url": "u", "cover": "", "series_url": "", "status": "",
              "rating": "", "genres": [], "description": "", "updated_time": ""}]
    with patch.object(svc.scraper_service, "collect_recent_chapters", return_value=(items, {})), \
         patch.object(svc.dispatch_service, "get_target_channels", return_value=[]):
        stats = svc.run_dispatch()
    assert stats["sent"] == 0
    assert stats["guilds"] == 0
