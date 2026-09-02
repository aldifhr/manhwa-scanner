"""Tests for app/storage/whitelist.py."""
import pytest
from unittest.mock import MagicMock, patch
from app.storage.whitelist import (
    WhitelistRow,
    load_whitelist,
    add_whitelist_entries,
    auto_cleanup_stale_whitelist,
    _norm_row,
)


class TestWhitelistRow:
    """Test WhitelistRow model — validation + serialization."""

    def test_minimal_row(self):
        row = WhitelistRow(title_key="testtitle", source="ikiru")
        assert row.title_key == "testtitle"
        assert row.source == "ikiru"
        assert row.genres == []

    def test_full_row(self):
        row = WhitelistRow(
            title_key="testtitle",
            source="shinigami",
            title="Test Title",
            url="https://example.com",
            rating=4.5,
            genres=["action", "drama"],
            status="active",
        )
        assert row.title == "Test Title"
        assert row.rating == 4.5
        assert row.genres == ["action", "drama"]

    def test_genres_from_string(self):
        row = WhitelistRow(title_key="test", source="ikiru", genres="action,drama,comedy")
        assert row.genres == ["action", "drama", "comedy"]

    def test_source_normalization(self):
        row = WhitelistRow(title_key="test", source="IKIRU")
        assert row.source == "ikiru"

    def test_to_db(self):
        row = WhitelistRow(title_key="test", source="ikiru", title="Test")
        db = row.to_db()
        assert db["title_key"] == "test"
        assert db["source"] == "ikiru"
        assert db["title"] == "Test"
        assert "created_at" in db


class TestLoadWhitelist:
    """Test load_whitelist() — loads whitelist."""

    def test_empty_db(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = []
        with patch("app.storage.whitelist.get_supabase", return_value=mock_sb):
            result = load_whitelist(force=True)
            assert result == []

    def test_with_data(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
            {"title_key": "title-1", "source": "ikiru", "title": "Title 1"},
        ]
        with patch("app.storage.whitelist.get_supabase", return_value=mock_sb):
            result = load_whitelist(force=True)
            assert len(result) == 1
            assert result[0]["title_key"] == "title-1"

    def test_exception_returns_empty(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.order.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.whitelist.get_supabase", return_value=mock_sb):
            result = load_whitelist(force=True)
            assert result == []


class TestAddWhitelistEntries:
    """Test add_whitelist_entries() — adds whitelist entries."""

    def test_empty_list(self):
        result = add_whitelist_entries([])
        assert result["status"] == "ok"

    def test_with_rows(self):
        mock_sb = MagicMock()
        with patch("app.storage.whitelist.get_supabase", return_value=mock_sb):
            result = add_whitelist_entries([
                {"title_key": "title-1", "source": "ikiru", "title": "Title 1"}
            ])
            assert result["status"] == "ok"
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.whitelist.get_supabase", return_value=mock_sb):
            result = add_whitelist_entries([{"title_key": "title-1", "source": "ikiru"}])
            assert result["status"] == "error"


class TestAutoCleanupStaleWhitelist:
    """Test auto_cleanup_stale_whitelist() — removes stale entries."""

    def test_no_stale_entries(self):
        mock_q = MagicMock(return_value=[])
        with patch("app.db.q", mock_q):
            result = auto_cleanup_stale_whitelist(days=30)
            assert result["status"] == "ok"
            assert result["removed"] == 0

    def test_dry_run(self):
        mock_q = MagicMock(return_value=[
            {"title_key": "old-title", "source": "ikiru", "title": "Old Title"},
        ])
        with patch("app.db.q", mock_q):
            result = auto_cleanup_stale_whitelist(days=30, dry_run=True)
            assert result["dry_run"] is True
            assert result["stale"] == 1

    def test_exception_handled(self):
        mock_q = MagicMock(side_effect=Exception("DB error"))
        with patch("app.db.q", mock_q):
            result = auto_cleanup_stale_whitelist(days=30)
            assert result["status"] == "error"  # Returns error on exception
