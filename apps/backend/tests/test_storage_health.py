"""Tests for app/storage/health.py."""
import pytest
from unittest.mock import MagicMock, patch, PropertyMock
from app.storage.health import (
    save_source_health_map,
    load_source_health_map,
    write_cron_status,
    write_dashboard_snapshot,
    read_dashboard_snapshot,
)


class TestSaveSourceHealthMap:
    """Test save_source_health_map() — batch upsert source health."""

    def test_empty_dict(self):
        with patch("app.storage.health.get_supabase") as mock_sb:
            save_source_health_map({})
            mock_sb.assert_not_called()

    @patch("app.config.settings")
    def test_with_valid_sources(self, mock_settings):
        mock_sb = MagicMock()
        mock_settings.SOURCE_KEYS = ["ikiru", "shinigami", "voratoon"]
        health_map = {
            "ikiru": {"status": "healthy", "consecutive_failures": 0, "response_time_ms": 100},
            "shinigami": {"status": "healthy", "consecutive_failures": 0},
        }
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            save_source_health_map(health_map)
            mock_sb.table.return_value.upsert.assert_called_once()

    @patch("app.config.settings")
    def test_cooldown_disabled_source(self, mock_settings):
        """Sources with status=disabled + last_error=cooldown should be skipped."""
        mock_sb = MagicMock()
        mock_settings.SOURCE_KEYS = ["ikiru", "shinigami", "voratoon"]
        health_map = {
            "voratoon": {"status": "disabled", "last_error": "cooldown"},
        }
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            save_source_health_map(health_map)
            mock_sb.table.return_value.upsert.assert_not_called()

    @patch("app.config.settings")
    def test_consecutive_failures_triggers_cooldown(self, mock_settings):
        """Sources with consecutive_failures >= 3 should get disabled_until set."""
        mock_sb = MagicMock()
        mock_settings.SOURCE_KEYS = ["ikiru", "shinigami", "voratoon"]
        health_map = {
            "ikiru": {"status": "degraded", "consecutive_failures": 3, "last_error": "timeout"},
        }
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            save_source_health_map(health_map)
            mock_sb.table.return_value.upsert.assert_called_once()
            call_args = mock_sb.table.return_value.upsert.call_args
            rows = call_args[0][0]
            assert rows[0]["disabled_until"] is not None

    @patch("app.config.settings")
    def test_exception_handled(self, mock_settings):
        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB error")
        mock_settings.SOURCE_KEYS = ["ikiru"]
        health_map = {"ikiru": {"status": "healthy"}}
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            save_source_health_map(health_map)  # Should not raise


class TestLoadSourceHealthMap:
    """Test load_source_health_map() — load health for sources."""

    def test_empty_keys(self):
        with patch("app.storage.health.get_supabase") as mock_sb:
            result = load_source_health_map([])
            assert result == {}

    def test_with_data(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.in_.return_value.execute.return_value.data = [
            {"source": "ikiru", "status": "healthy"},
            {"source": "shinigami", "status": "degraded"},
        ]
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            result = load_source_health_map(["ikiru", "shinigami"])
            assert result == {
                "ikiru": {"source": "ikiru", "status": "healthy"},
                "shinigami": {"source": "shinigami", "status": "degraded"},
            }

    def test_exception_returns_empty(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.in_.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            result = load_source_health_map(["ikiru"])
            assert result == {}


class TestWriteCronStatus:
    """Test write_cron_status() — insert cron run status."""

    def test_with_all_fields(self):
        mock_sb = MagicMock()
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            write_cron_status(status="completed", chapters_sent=5, matched=10, duration=2.5)
            mock_sb.table.return_value.insert.assert_called_once()

    def test_duration_defaults_to_zero(self):
        mock_sb = MagicMock()
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            write_cron_status(status="failed")
            mock_sb.table.return_value.insert.assert_called_once()
            call_args = mock_sb.table.return_value.insert.call_args
            row = call_args[0][0]
            assert row["duration"] == 0.0

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.insert.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            write_cron_status(status="completed")  # Should not raise


class TestWriteDashboardSnapshot:
    """Test write_dashboard_snapshot() — persist dashboard payload."""

    def test_write(self):
        mock_sb = MagicMock()
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            write_dashboard_snapshot({"key": "value"})
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_exception_handled(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            write_dashboard_snapshot({"key": "value"})  # Should not raise


class TestReadDashboardSnapshot:
    """Test read_dashboard_snapshot() — read snapshot with TTL."""

    def test_fresh_snapshot(self):
        mock_sb = MagicMock()
        from datetime import datetime, timezone, timedelta
        fresh_time = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        mock_sb.table.return_value.select.return_value.eq.return_value.limit.return_value.maybe_single.return_value.execute.return_value.data = {
            "payload": {"key": "value"},
            "computed_at": fresh_time,
        }
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            result = read_dashboard_snapshot()
            assert result == {"payload": {"key": "value"}, "computed_at": fresh_time}

    def test_stale_snapshot_returns_none(self):
        mock_sb = MagicMock()
        from datetime import datetime, timezone, timedelta
        stale_time = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        mock_sb.table.return_value.select.return_value.eq.return_value.limit.return_value.maybe_single.return_value.execute.return_value.data = {
            "payload": {"key": "value"},
            "computed_at": stale_time,
        }
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            result = read_dashboard_snapshot()
            assert result is None

    def test_no_snapshot_returns_none(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.eq.return_value.limit.return_value.maybe_single.return_value.execute.return_value.data = None
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            result = read_dashboard_snapshot()
            assert result is None

    def test_exception_returns_none(self):
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.eq.return_value.limit.return_value.maybe_single.return_value.execute.side_effect = Exception("DB error")
        with patch("app.storage.health.get_supabase", return_value=mock_sb):
            result = read_dashboard_snapshot()
            assert result is None
