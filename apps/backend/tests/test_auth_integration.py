"""Integration tests for auth endpoints: login, password validation, JWT, refresh, access control."""
import time
from unittest.mock import patch

import jwt as _jwt
import pytest
from fastapi.testclient import TestClient


def _get_client():
    """Lazy import — runs after conftest sets env vars."""
    from app.main import app
    return TestClient(app)


def _get_auth_module():
    """Lazy import — runs after conftest sets env vars."""
    from app.api import auth as auth_module
    return auth_module


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    """Fresh TestClient per test (cookie jar isolation)."""
    return _get_client()


@pytest.fixture(autouse=True)
def _relax_cookie_domain(monkeypatch):
    """Drop cookie Domain so TestClient jar works (testserver != aldifhr.fun)."""
    auth_module = _get_auth_module()

    def _set_cookies_test(resp, token):
        import secrets as _secrets
        resp.set_cookie(
            key=auth_module._COOKIE_SESSION,
            value=token,
            httponly=True,
            path="/",
            max_age=auth_module._COOKIE_MAX_AGE,
        )
        resp.set_cookie(
            key=auth_module._COOKIE_CSRF,
            value=_secrets.token_urlsafe(32),
            httponly=False,
            path="/",
            max_age=auth_module._COOKIE_MAX_AGE,
        )
        resp.delete_cookie(key="ikiru_role", path="/")

    monkeypatch.setattr(auth_module, "_set_session_cookies", _set_cookies_test)


# ---------------------------------------------------------------------------
# Login flow
# ---------------------------------------------------------------------------

class TestLoginFlow:
    def test_login_success_returns_200(self, client):
        r = client.post("/api/v1/auth?action=login", json={"password": "manhwascan"})
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert body["data"]["ok"] is True

    def test_login_sets_session_and_csrf_cookies(self, client):
        r = client.post("/api/v1/auth?action=login", json={"password": "manhwascan"})
        assert "ikiru_dashboard_session" in r.cookies
        assert "ikiru_csrf_token" in r.cookies

    def test_login_invalid_password_returns_401(self, client):
        r = client.post("/api/v1/auth?action=login", json={"password": "wrong"})
        assert r.status_code == 401
        assert r.json()["error"] == "Invalid credentials"

    def test_login_empty_password_returns_401(self, client):
        r = client.post("/api/v1/auth?action=login", json={"password": ""})
        assert r.status_code == 401

    def test_login_missing_body_returns_401(self, client):
        r = client.post("/api/v1/auth?action=login", json={})
        assert r.status_code == 401

    def test_login_invalid_json_returns_400(self, client):
        r = client.post(
            "/api/v1/auth?action=login",
            content="not json",
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 400
        assert r.json()["error"] == "Invalid body"

    def test_login_unknown_action_returns_400(self, client):
        r = client.post("/api/v1/auth?action=bogus", json={"password": "manhwascan"})
        assert r.status_code == 400
        assert r.json()["error"] == "Unknown action"

    def test_login_monitor_token_works_as_password(self, client):
        """MONITOR_AUTH_TOKEN is a valid login password (alias)."""
        r = client.post("/api/v1/auth?action=login", json={"password": "monitor-token"})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Password validation
# ---------------------------------------------------------------------------

class TestPasswordValidation:
    def test_dashboard_password_valid(self):
        auth_module = _get_auth_module()
        assert auth_module._password_ok("manhwascan") is True

    def test_monitor_token_valid(self):
        auth_module = _get_auth_module()
        assert auth_module._password_ok("monitor-token") is True

    def test_wrong_password_rejected(self):
        auth_module = _get_auth_module()
        assert auth_module._password_ok("wrong") is False

    def test_empty_password_rejected(self):
        auth_module = _get_auth_module()
        assert auth_module._password_ok("") is False

    def test_timing_safe_no_early_exit(self):
        """hmac.compare_digest — near-misses rejected without timing leak."""
        auth_module = _get_auth_module()
        assert auth_module._password_ok("manhwascan ") is False
        assert auth_module._password_ok(" manhwascan") is False
        assert auth_module._password_ok("MANHWASCAN") is False


# ---------------------------------------------------------------------------
# JWT token creation
# ---------------------------------------------------------------------------

class TestTokenCreation:
    def test_jwt_payload_has_required_claims(self):
        auth_module = _get_auth_module()
        token = auth_module._issue_jwt()
        payload = _jwt.decode(token, "test-auth-secret", algorithms=["HS256"])
        assert payload["sub"] == "dashboard"
        assert "exp" in payload
        assert "iat" in payload

    def test_jwt_expiry_is_7_days(self):
        auth_module = _get_auth_module()
        token = auth_module._issue_jwt()
        payload = _jwt.decode(token, "test-auth-secret", algorithms=["HS256"])
        # 7 days = 604800s, allow 5s tolerance for test execution
        assert 604795 <= (payload["exp"] - payload["iat"]) <= 604805

    def test_role_from_jwt_valid_token(self):
        auth_module = _get_auth_module()
        token = auth_module._issue_jwt()
        assert auth_module.role_from_jwt(token) == "user"

    def test_role_from_jwt_invalid_token(self):
        auth_module = _get_auth_module()
        assert auth_module.role_from_jwt("invalid.token.here") is None

    def test_role_from_jwt_empty_string(self):
        auth_module = _get_auth_module()
        assert auth_module.role_from_jwt("") is None


# ---------------------------------------------------------------------------
# Token refresh
# ---------------------------------------------------------------------------

class TestTokenRefresh:
    def test_refresh_with_cookie_session(self, client):
        login_resp = client.post("/api/v1/auth?action=login", json={"password": "manhwascan"})
        assert login_resp.status_code == 200

        r = client.post("/api/v1/auth?action=refresh")
        assert r.status_code == 200
        assert r.json()["success"] is True

    def test_refresh_issues_new_token(self, client):
        """Refresh returns a valid JWT cookie (may be same value if within same second)."""
        login_resp = client.post("/api/v1/auth?action=login", json={"password": "manhwascan"})
        assert login_resp.status_code == 200

        r = client.post("/api/v1/auth?action=refresh")
        new_token = r.cookies.get("ikiru_dashboard_session")
        assert new_token is not None
        # Verify it's a valid JWT
        payload = _jwt.decode(new_token, "test-auth-secret", algorithms=["HS256"])
        assert payload["sub"] == "dashboard"

    def test_refresh_without_session_returns_401(self, client):
        r = client.post("/api/v1/auth?action=refresh")
        assert r.status_code == 401
        assert r.json()["error"] == "unauthorized"

    def test_refresh_with_invalid_token_returns_401(self, client):
        r = client.post(
            "/api/v1/auth?action=refresh",
            headers={"Authorization": "Bearer invalid.token.here"},
        )
        assert r.status_code == 401

    def test_refresh_with_bearer_token(self, client):
        """Refresh works with Bearer token, not just cookie."""
        auth_module = _get_auth_module()
        token = auth_module._issue_jwt()
        r = client.post(
            "/api/v1/auth?action=refresh",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Auth check (GET /auth) — "logout" = not authenticated
# ---------------------------------------------------------------------------

class TestAuthMe:
    def test_auth_me_with_valid_session(self, client):
        client.post("/api/v1/auth?action=login", json={"password": "manhwascan"})
        r = client.get("/api/v1/auth")
        assert r.status_code == 200
        assert r.json()["data"]["authenticated"] is True

    def test_auth_me_without_session_returns_401(self, client):
        r = client.get("/api/v1/auth")
        assert r.status_code == 401
        assert r.json()["error"] == "unauthorized"

    def test_auth_me_with_bearer_token(self, client):
        auth_module = _get_auth_module()
        token = auth_module._issue_jwt()
        r = client.get("/api/v1/auth", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200

    def test_auth_me_with_invalid_token_returns_401(self, client):
        r = client.get("/api/v1/auth", headers={"Authorization": "Bearer bad.token"})
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Access control for protected endpoints
# ---------------------------------------------------------------------------

class TestAccessControl:
    def test_protected_endpoint_with_valid_bearer(self, client):
        r = client.get("/api/v1/health", headers={"Authorization": "Bearer monitor-token"})
        assert r.status_code == 200

    def test_protected_endpoint_without_token_returns_401(self, client):
        r = client.get("/api/v1/health")
        assert r.status_code == 401
        assert r.json()["error"] == "unauthorized"

    def test_protected_endpoint_with_invalid_token_returns_401(self, client):
        r = client.get("/api/v1/health", headers={"Authorization": "Bearer wrong-token"})
        assert r.status_code == 401

    def test_protected_endpoint_with_session_cookie(self, client):
        """Cookie-based auth on protected endpoint."""
        client.post("/api/v1/auth?action=login", json={"password": "manhwascan"})
        r = client.get("/api/v1/health")
        assert r.status_code == 200

    def test_protected_endpoint_with_query_param_token(self, client):
        """?token= query param auth on protected endpoint."""
        r = client.get("/api/v1/health?token=monitor-token")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# AUTH_DISABLED behavior (test function directly — pydantic frozen blocks monkeypatch)
# ---------------------------------------------------------------------------

class TestAuthDisabled:
    def test_auth_disabled_allows_access_in_dev(self):
        """AUTH_DISABLED=true in dev bypasses auth."""
        from app.utils.auth import check_monitor_auth
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.AUTH_DISABLED = True
            mock_settings.ENVIRONMENT = "development"
            mock_settings.DASHBOARD_PASSWORD = "manhwascan"
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-token"
            assert check_monitor_auth("") is True

    def test_auth_disabled_blocked_in_production(self):
        """AUTH_DISABLED=true is ignored in production — auth enforced."""
        from app.utils.auth import check_monitor_auth
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.AUTH_DISABLED = True
            mock_settings.ENVIRONMENT = "production"
            mock_settings.DASHBOARD_PASSWORD = "manhwascan"
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-token"
            # In production, AUTH_DISABLED is ignored — no token = unauthorized
            assert check_monitor_auth("") is False

    def test_auth_disabled_allows_in_dev_even_with_wrong_token(self):
        """AUTH_DISABLED=true in dev — even wrong token passes."""
        from app.utils.auth import check_monitor_auth
        with patch("app.utils.auth.settings") as mock_settings:
            mock_settings.AUTH_DISABLED = True
            mock_settings.ENVIRONMENT = "development"
            mock_settings.DASHBOARD_PASSWORD = "manhwascan"
            mock_settings.MONITOR_AUTH_TOKEN = "monitor-token"
            assert check_monitor_auth("Bearer wrong-token") is True


# ---------------------------------------------------------------------------
# Legacy cookie cleanup
# ---------------------------------------------------------------------------

class TestLegacyCookieCleanup:
    def test_login_clears_legacy_role_cookie(self, client):
        """Login deletes the legacy ikiru_role cookie."""
        r = client.post("/api/v1/auth?action=login", json={"password": "manhwascan"})
        assert r.status_code == 200
        set_cookie_headers = r.headers.get_list("set-cookie")
        role_deletes = [h for h in set_cookie_headers if "ikiru_role" in h]
        assert len(role_deletes) >= 1
