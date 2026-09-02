"""Unit tests for app/services/dispatch_service.py (mocked)."""
import pytest
from unittest.mock import patch, MagicMock
from app.services.dispatch_service import DispatchService


def _mock_supabase(rows):
    sb = MagicMock()
    res = MagicMock()
    res.data = rows
    # support both .select().execute() and .select().in_().execute()
    sb.table.return_value.select.return_value.execute.return_value = res
    sb.table.return_value.select.return_value.in_.return_value.execute.return_value = res
    return sb


def test_get_target_channels():
    svc = DispatchService()
    sb = _mock_supabase([{"channel_id": "c1"}, {"channel_id": "c2"}])
    with patch("app.services.dispatch_service.get_supabase", return_value=sb):
        chans = svc.get_target_channels()
    assert chans == ["c1", "c2"]


def test_get_claimed_keys():
    svc = DispatchService()
    sb = _mock_supabase([{"fcfs_key": "lookism#1"}, {"fcfs_key": "tower#2"}])
    with patch("app.services.dispatch_service.get_supabase", return_value=sb):
        out = svc.get_claimed_keys(["lookism#1", "nope#9"])
    assert out == {"lookism#1", "tower#2"}


def test_get_claimed_urls():
    svc = DispatchService()
    sb = _mock_supabase([{"chapter_url": "https://x/1"}])
    with patch("app.services.dispatch_service.get_supabase", return_value=sb):
        out = svc.get_claimed_urls(["https://x/1", "https://y/2"])
    assert out == {"https://x/1"}


def test_get_claimed_keys_empty():
    svc = DispatchService()
    assert svc.get_claimed_keys([]) == set()


def test_send_chapter_no_cover():
    svc = DispatchService()
    item = {
        "title": "Test", "chapter": "1", "url": "https://x/1",
        "series_url": "s", "source": "ikiru", "cover": "",
        "status": "", "rating": "", "genres": [], "description": "", "updated_time": "",
    }
    with patch("app.services.dispatch_service.discord.send_channel_message", return_value={"id": "123"}) as m:
        ok = svc.send_chapter(item, "chan")
    assert ok is True
    m.assert_called_once()


def test_send_chapter_with_cover():
    svc = DispatchService()
    item = {"title": "T", "chapter": "1", "url": "u", "series_url": "s",
            "source": "ikiru", "cover": "https://x/c.jpg", "status": "", "rating": "", "genres": [], "description": "", "updated_time": ""}
    with patch("app.services.dispatch_service.discord.send_channel_message_with_attachments", return_value={"id": "1"}) as m, \
         patch("app.discord.http.fetch_cover", return_value=(b"data", "image/jpeg")):
        ok = svc.send_chapter(item, "chan")
    assert ok is True
    m.assert_called_once()


def test_update_latest_sent_chapter():
    svc = DispatchService()
    with patch("app.db.q") as q:
        svc.update_latest_sent_chapter("lookism", "shinigami", 621.0)
        assert q.called
        assert "GREATEST" in q.call_args[0][0].upper()
