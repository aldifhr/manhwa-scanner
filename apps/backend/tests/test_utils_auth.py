"""Tests for app/utils/auth.py."""
import pytest
from unittest.mock import MagicMock, patch
from app.utils.auth import (
    token_matches,
    cron_token_matches,
    monitor_token_matches,
    check_monitor_auth,
    role_from_request,
    require_role,
    check_cron_auth,
)


class TestTokenMatches:
    """Test token_matches() — constant-time token comparison."""

    def test_empty_provided(self):
        assert token_matches("") is False
        assert token_matches(None) is False

    def test_cron_role_match(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.FASTCRON_API_KEY = ""
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            assert token_matches("cron-secret", role="cron") is True

    def test_monitor_role_match(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            assert token_matches("monitor-secret", role="monitor") is True

    def test_wrong_token(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            assert token_matches("wrong-token", role="both") is False

    def test_no_candidates(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = ""
            mock_settings.FASTCRON_API_KEY = ""
            mock_settings.MONITOR_AUTH_TOKEN = ""
            assert token_matches("any-token", role="both") is False

    def test_non_ascii_token(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "secret"
            assert token_matches("secret\u0000", role="monitor") is False


class TestCronTokenMatches:
    """Test cron_token_matches() — cron-specific check."""

    def test_match(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.FASTCRON_API_KEY = ""
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            assert cron_token_matches("cron-secret") is True

    def test_no_match(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.FASTCRON_API_KEY = ""
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            assert cron_token_matches("monitor-secret") is False


class TestMonitorTokenMatches:
    """Test monitor_token_matches() — monitor-specific check."""

    def test_match(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            assert monitor_token_matches("monitor-secret") is True

    def test_no_match(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            assert monitor_token_matches("cron-secret") is False


class TestCheckMonitorAuth:
    """Test check_monitor_auth() — full auth check."""

    def test_bearer_header(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            assert check_monitor_auth("Bearer monitor-secret") is True

    def test_token_param(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            assert check_monitor_auth("", token_param="monitor-secret") is True

    def test_invalid_token(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            assert check_monitor_auth("Bearer wrong-token") is False

    def test_no_monitor_token_configured(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = ""
            mock_settings.AUTH_DISABLED = False
            assert check_monitor_auth("Bearer any-token") is False

    def test_auth_disabled_in_dev(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.AUTH_DISABLED = True
            mock_settings.ENVIRONMENT = "development"
            assert check_monitor_auth("") is True

    def test_auth_disabled_in_production(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.AUTH_DISABLED = True
            mock_settings.ENVIRONMENT = "production"
            mock_settings.MONITOR_AUTH_TOKEN = "secret"
            assert check_monitor_auth("") is False


class TestRoleFromRequest:
    """Test role_from_request() — resolve role from request."""

    def test_bearer_admin(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.CRON_SECRET = "cron-secret"
            assert role_from_request("Bearer monitor-secret") == "admin"

    def test_token_param_admin(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.CRON_SECRET = "cron-secret"
            assert role_from_request("", token_param="monitor-secret") == "admin"

    def test_no_auth(self):
        assert role_from_request("") is None


class TestRequireRole:
    """Test require_role() — role-based access control."""

    def test_admin_access(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            assert require_role({"admin"}, "Bearer monitor-secret") is True

    def test_member_access(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            # Bearer token gives admin role, which is in allowed set
            assert require_role({"admin", "member"}, "Bearer monitor-secret") is True

    def test_unauthenticated(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            assert require_role({"admin"}, "Bearer wrong-token") is False


class TestCheckCronAuth:
    """Test check_cron_auth() — cron-specific auth."""

    def test_valid_cron_token(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            assert check_cron_auth("cron-secret") is True

    def test_invalid_cron_token(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = "cron-secret"
            mock_settings.AUTH_DISABLED = False
            mock_settings.ENVIRONMENT = "production"
            assert check_cron_auth("wrong-token") is False

    def test_no_cron_secret_configured(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.CRON_SECRET = ""
            mock_settings.AUTH_DISABLED = False
            assert check_cron_auth("any-token") is False

    def test_auth_disabled_in_dev(self):
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.AUTH_DISABLED = True
            mock_settings.ENVIRONMENT = "development"
            assert check_cron_auth("") is True
