"""Tests for app/storage/dispatch.py."""
import pytest
from unittest.mock import MagicMock, patch
from app.storage.dispatch import (
    _already_dispatched,
    _claimed_urls,
    _claimed_fcfs_keys,
    mark_claimed,
    record_failed,
    unclaim,
    unclaim_stale,
    claim_and_record,
    complete_dispatch_claim,
)


class TestAlreadyDispatched:
    """Test _already_dispatched() — checks dispatch_history."""

    def test_empty_list(self):
        assert _already_dispatched([]) == set()

    def test_found_urls(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.in_.return_value.execute.return_value.data = [
            {"chapter_url": "https://example.com/ch1"},
            {"chapter_url": "https://example.com/ch2"},
        ]
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            result = _already_dispatched(["https://example.com/ch1", "https://example.com/ch2", "https://example.com/ch3"])
            assert result == {"https://example.com/ch1", "https://example.com/ch2"}

    def test_no_matches(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.in_.return_value.execute.return_value.data = []
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            result = _already_dispatched(["https://example.com/ch1"])
            assert result == set()

    def test_exception_returns_empty(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.in_.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            result = _already_dispatched(["https://example.com/ch1"])
            assert result == set()


class TestClaimedUrls:
    """Test _claimed_urls() — checks dispatch_claims."""

    def test_empty_list(self):
        assert _claimed_urls([]) == set()

    def test_found_urls(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.in_.return_value.gte.return_value.execute.return_value.data = [
            {"chapter_url": "https://example.com/ch1"},
        ]
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            result = _claimed_urls(["https://example.com/ch1", "https://example.com/ch2"])
            assert result == {"https://example.com/ch1"}

    def test_exception_returns_empty(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.in_.return_value.gte.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            result = _claimed_urls(["https://example.com/ch1"])
            assert result == set()


class TestClaimedFcfsKeys:
    """Test _claimed_fcfs_keys() — delegates to fcfs service."""

    def test_delegates(self):
        with patch("app.services.fcfs.claimed_fcfs_keys", return_value={"key1", "key2"}) as mock_cf:
            result = _claimed_fcfs_keys(["key1", "key2", "key3"])
            assert result == {"key1", "key2"}
            mock_cf.assert_called_once_with(["key1", "key2", "key3"])


class TestMarkClaimed:
    """Test mark_claimed() — marks URLs as claimed."""

    def test_empty_list(self):
        with patch("app.storage.dispatch.get_supabase") as mock_sb:
            mark_claimed([], [])
            mock_sb.assert_not_called()

    def test_with_urls(self):
        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            mark_claimed(["https://example.com/ch1"], ["title1"])
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_empty_url_skipped(self):
        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            mark_claimed(["", "https://example.com/ch1"], ["title1", "title2"])
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            mark_claimed(["https://example.com/ch1"], ["title1"])  # Should not raise


class TestRecordFailed:
    """Test record_failed() — records failed dispatch."""

    def test_empty_url(self):
        with patch("app.storage.dispatch.get_supabase") as mock_sb:
            record_failed("")
            mock_sb.assert_not_called()

    def test_with_all_fields(self):
        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            record_failed(
                chapter_url="https://example.com/ch1",
                title_key="title1",
                source="shinigami",
                chapter_title="Chapter 1",
                chapter_number=1.0,
                error_message="Discord down",
                error_code="DISCORD_500",
            )
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            record_failed("https://example.com/ch1")  # Should not raise


class TestUnclaim:
    """Test unclaim() — removes from dispatch_history + dispatch_claims."""

    def test_empty_url(self):
        with patch("app.storage.dispatch.get_supabase") as mock_sb:
            unclaim("")
            mock_sb.assert_not_called()

    def test_with_url(self):
        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            unclaim("https://example.com/ch1")
            assert mock_sb.table.return_value.delete.return_value.eq.return_value.execute.call_count == 2

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.delete.return_value.eq.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            unclaim("https://example.com/ch1")  # Should not raise


class TestUnclaimStale:
    """Test unclaim_stale() — deletes old claims."""

    def test_empty_cutoff(self):
        with patch("app.storage.dispatch.get_supabase") as mock_sb:
            result = unclaim_stale("")
            assert result == 0
            mock_sb.assert_not_called()

    def test_with_cutoff(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.delete.return_value.lt.return_value.execute.return_value.data = [
            {"chapter_url": "url1"},
            {"chapter_url": "url2"},
        ]
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            result = unclaim_stale("2026-01-01T00:00:00")
            assert result == 2

    def test_exception_returns_zero(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.delete.return_value.lt.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            result = unclaim_stale("2026-01-01T00:00:00")
            assert result == 0


class TestClaimAndRecord:
    """Test claim_and_record() — atomic claim guard."""

    def test_empty_list(self):
        result = claim_and_record([], [], [], "test")
        assert result == []

    def test_new_claims(self):
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.fetchall.return_value = []
        with patch("app.db.get_conn", return_value=mock_conn):
            with patch("app.db.put_conn"):
                result = claim_and_record(
                    ["https://example.com/ch1"],
                    ["title1"],
                    ["shinigami"],
                    "test",
                )
                assert result == [True]

    def test_already_claimed(self):
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.fetchall.return_value = [
            {"chapter_url": "https://example.com/ch1"},
        ]
        with patch("app.db.get_conn", return_value=mock_conn):
            with patch("app.db.put_conn"):
                result = claim_and_record(
                    ["https://example.com/ch1"],
                    ["title1"],
                    ["shinigami"],
                    "test",
                )
                assert result == [False]

    def test_with_fcfs_keys(self):
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.fetchall.return_value = []
        with patch("app.db.get_conn", return_value=mock_conn):
            with patch("app.db.put_conn"):
                result = claim_and_record(
                    ["https://example.com/ch1"],
                    ["title1"],
                    ["shinigami"],
                    "test",
                    fcfs_keys=["title1-ch1"],
                )
                assert result == [True]


class TestCompleteDispatchClaim:
    """Test complete_dispatch_claim() — records sent chapter."""

    def test_with_fcfs_key(self):
        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            complete_dispatch_claim(
                chapter_url="https://example.com/ch1",
                duplicate_url=None,
                instance_id="test",
                title_key="title1",
                source="shinigami",
                fcfs_key="title1-ch1",
                chapter_title="Chapter 1",
                cover="https://example.com/cover.jpg",
                series_url="https://example.com/series",
            )
            # Should upsert on fcfs_key
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_without_fcfs_key(self):
        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            complete_dispatch_claim(
                chapter_url="https://example.com/ch1",
                duplicate_url=None,
                instance_id="test",
                title_key="title1",
            )
            # Should insert
            mock_sb.table.return_value.insert.assert_called_once()

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            complete_dispatch_claim(
                chapter_url="https://example.com/ch1",
                duplicate_url=None,
                instance_id="test",
                fcfs_key="title1-ch1",
            )  # Should not raise
