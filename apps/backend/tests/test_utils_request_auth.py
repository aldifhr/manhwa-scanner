"""Tests for app/utils/request_auth.py."""
import pytest
from unittest.mock import MagicMock, patch
from app.utils.request_auth import (
    require_monitor_auth,
    require_cron_auth,
    require_role_auth,
    int_safe,
    safe_error,
)


class TestRequireMonitorAuth:
    """Test require_monitor_auth() — monitor auth from request."""

    def test_bearer_header(self):
        mock_request = MagicMock()
        mock_request.headers = {"authorization": "Bearer monitor-secret"}
        mock_request.query_params = {}
        mock_request.cookies = {}
        with patch("app.utils.request_auth.check_monitor_auth", return_value=True):
            assert require_monitor_auth(mock_request) is True

    def test_token_param(self):
        mock_request = MagicMock()
        mock_request.headers = {}
        mock_request.query_params = {"token": "monitor-secret"}
        mock_request.cookies = {}
        with patch("app.utils.request_auth.check_monitor_auth", return_value=True):
            assert require_monitor_auth(mock_request) is True


class TestRequireCronAuth:
    """Test require_cron_auth() — cron auth from request."""

    def test_valid_token(self):
        mock_request = MagicMock()
        mock_request.query_params = {"token": "cron-secret"}
        with patch("app.utils.auth.check_cron_auth", return_value=True):
            assert require_cron_auth(mock_request) is True


class TestRequireRoleAuth:
    """Test require_role_auth() — role-based auth from request."""

    def test_admin_access(self):
        mock_request = MagicMock()
        mock_request.headers = {"authorization": "Bearer monitor-secret"}
        mock_request.query_params = {}
        mock_request.cookies = {}
        with patch("app.utils.request_auth.check_monitor_auth", return_value=True):
            with patch("app.utils.request_auth.role_from_request", return_value="admin"):
                assert require_role_auth(mock_request, {"admin"}) is True

    def test_member_access(self):
        mock_request = MagicMock()
        mock_request.headers = {}
        mock_request.query_params = {}
        mock_request.cookies = {}
        with patch("app.utils.request_auth.check_monitor_auth", return_value=True):
            with patch("app.utils.request_auth.role_from_request", return_value="member"):
                assert require_role_auth(mock_request, {"admin", "member"}) is True

    def test_unauthenticated(self):
        mock_request = MagicMock()
        mock_request.headers = {}
        mock_request.query_params = {}
        mock_request.cookies = {}
        with patch("app.utils.request_auth.check_monitor_auth", return_value=False):
            assert require_role_auth(mock_request, {"admin"}) is False


class TestIntSafe:
    """Test int_safe() — safe int parsing."""

    def test_valid_int(self):
        assert int_safe("42") == 42

    def test_none_returns_default(self):
        assert int_safe(None) == 0

    def test_invalid_returns_default(self):
        assert int_safe("not-a-number") == 0

    def test_max_val_clamp(self):
        assert int_safe("100", max_val=50) == 50

    def test_negative_returns_default(self):
        assert int_safe("-5") == 0

    def test_custom_default(self):
        assert int_safe(None, default=10) == 10


class TestSafeError:
    """Test safe_error() — generic error payload."""

    def test_returns_dict(self):
        result = safe_error(Exception("test"))
        assert result["success"] is False
        assert "error" in result

    def test_custom_message(self):
        result = safe_error(Exception("test"), message="custom error")
        assert result["error"] == "custom error"
