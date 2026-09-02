"""Tests for app/storage/excluded_titles.py."""
import pytest
from unittest.mock import MagicMock, patch
from app.storage.excluded_titles import (
    load_excluded_keys,
    is_excluded,
    add_excluded_title,
    remove_excluded_title,
    list_excluded_titles,
    exclude_all_by_source,
    _norm_source,
)
from app.utils.text import normalize_title_key


@pytest.fixture(autouse=True)
def reset_cache():
    """Reset global cache before each test."""
    import app.storage.excluded_titles as mod
    mod._CACHE = None
    mod._CACHE_TS = 0.0
    yield
    mod._CACHE = None
    mod._CACHE_TS = 0.0


class TestNormSource:
    """Test _norm_source() — normalizes source names."""

    def test_valid_sources(self):
        assert _norm_source("ikiru") == "ikiru"
        assert _norm_source("shinigami") == "shinigami"
        assert _norm_source("voratoon") == "voratoon"
        assert _norm_source("all") == "all"

    def test_invalid_source_defaults_to_all(self):
        assert _norm_source("invalid") == "all"
        assert _norm_source("") == "all"

    def test_case_insensitive(self):
        assert _norm_source("IKIRU") == "ikiru"
        assert _norm_source("Shinigami") == "shinigami"


class TestLoadExcludedKeys:
    """Test load_excluded_keys() — loads excluded title keys."""

    def test_empty_db(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.execute.return_value.data = []
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = load_excluded_keys(force=True)
            assert result == set()

    def test_with_data(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.execute.return_value.data = [
            {"title_key": "title 1", "source": "ikiru"},
            {"title_key": "title 2", "source": "all"},
        ]
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = load_excluded_keys(force=True)
            assert result == {("title 1", "ikiru"), ("title 2", "all")}

    def test_cache_hit(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.execute.return_value.data = [
            {"title_key": "title 1", "source": "ikiru"},
        ]
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            load_excluded_keys(force=True)
            load_excluded_keys()  # Should use cache
            assert mock_sb.table.call_count == 1

    def test_exception_returns_empty(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = load_excluded_keys(force=True)
            assert result == set()


class TestIsExcluded:
    """Test is_excluded() — checks if title is excluded."""

    def test_excluded_for_source(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.execute.return_value.data = [
            {"title_key": "title 1", "source": "ikiru"},
        ]
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            assert is_excluded("title 1", "ikiru") is True

    def test_excluded_for_all(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.execute.return_value.data = [
            {"title_key": "title 1", "source": "all"},
        ]
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            assert is_excluded("title 1", "shinigami") is True

    def test_not_excluded(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.execute.return_value.data = []
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            assert is_excluded("title 1", "ikiru") is False


class TestAddExcludedTitle:
    """Test add_excluded_title() — adds excluded title."""

    def test_success(self):
        mock_sb = MagicMock()
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = add_excluded_title("title-1", title="Title 1", source="ikiru")
            assert result["status"] == "ok"
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_empty_title_key(self):
        result = add_excluded_title("")
        assert result["status"] == "error"

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = add_excluded_title("title-1")
            assert result["status"] == "error"


class TestRemoveExcludedTitle:
    """Test remove_excluded_title() — removes excluded title."""

    def test_success(self):
        mock_sb = MagicMock()
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = remove_excluded_title("title-1", "ikiru")
            assert result["status"] == "ok"
            mock_sb.table.return_value.delete.return_value.eq.return_value.eq.return_value.execute.assert_called_once()

    def test_empty_title_key(self):
        result = remove_excluded_title("")
        assert result["status"] == "error"

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.delete.return_value.eq.return_value.eq.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = remove_excluded_title("title-1")
            assert result["status"] == "error"


class TestListExcludedTitles:
    """Test list_excluded_titles() — lists all excluded titles."""

    def test_with_data(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
            {"title_key": "title-1", "source": "ikiru"},
        ]
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = list_excluded_titles()
            assert len(result) == 1

    def test_empty(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = []
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = list_excluded_titles()
            assert result == []

    def test_exception_returns_empty(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.order.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = list_excluded_titles()
            assert result == []


class TestExcludeAllBySource:
    """Test exclude_all_by_source() — bulk exclude by source."""

    def test_all_source_rejected(self):
        result = exclude_all_by_source("all")
        assert result["status"] == "error"

    def test_success(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {"title_key": "title-1", "title": "Title 1", "series_url": "https://example.com/t1", "cover": "https://example.com/c1.jpg"},
        ]
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = exclude_all_by_source("ikiru")
            assert result["status"] == "ok"
            assert result["excluded"] == 1

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.eq.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.excluded_titles.get_supabase", return_value=mock_sb):
            result = exclude_all_by_source("ikiru")
            assert result["status"] == "error"
