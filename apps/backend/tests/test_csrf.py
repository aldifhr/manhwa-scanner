"""CSRF middleware integration tests.

Tests the double-submit cookie CSRF protection:
- Mutating requests without CSRF token are rejected (403)
- Matching cookie + header is accepted
- Bearer auth bypasses CSRF
- Whitelisted paths bypass CSRF
- Cross-origin requests are blocked (CORS)
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

CSRF_COOKIE = "ikiru_csrf_token"
CSRF_HEADER = "x-csrf-token"
# POST endpoint NOT whitelisted — CSRF applies
PROTECTED_POST = "/api/v1/health/refresh-voratoon"


def _assert_not_csrf_failure(response):
    """Assert response is not a CSRF 403."""
    if response.status_code == 403:
        assert response.json().get("error") != "CSRF validation failed"


class TestCsrfRejection:
    """Mutating requests without valid CSRF token are rejected."""

    @pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
    def test_mutating_without_csrf_returns_403(self, method):
        r = getattr(client, method)(PROTECTED_POST)
        assert r.status_code == 403
        assert r.json()["error"] == "CSRF validation failed"

    def test_post_with_mismatched_cookie_and_header(self):
        r = client.post(
            PROTECTED_POST,
            cookies={CSRF_COOKIE: "cookie-value"},
            headers={CSRF_HEADER: "header-value"},
        )
        assert r.status_code == 403
        assert r.json()["error"] == "CSRF validation failed"

    def test_post_with_only_cookie_no_header(self):
        r = client.post(
            PROTECTED_POST,
            cookies={CSRF_COOKIE: "cookie-value"},
        )
        assert r.status_code == 403

    def test_post_with_only_header_no_cookie(self):
        r = client.post(
            PROTECTED_POST,
            headers={CSRF_HEADER: "header-value"},
        )
        assert r.status_code == 403

    def test_post_with_empty_cookie_and_header(self):
        r = client.post(
            PROTECTED_POST,
            cookies={CSRF_COOKIE: ""},
            headers={CSRF_HEADER: ""},
        )
        assert r.status_code == 403


class TestCsrfAcceptance:
    """Matching cookie + header passes CSRF check."""

    @pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
    def test_matching_cookie_and_header_passes_csrf(self, method):
        r = getattr(client, method)(
            PROTECTED_POST,
            cookies={CSRF_COOKIE: "matching-token"},
            headers={CSRF_HEADER: "matching-token"},
        )
        _assert_not_csrf_failure(r)


class TestBearerBypass:
    """Bearer auth bypasses CSRF check."""

    @pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
    def test_bearer_skips_csrf(self, method):
        r = getattr(client, method)(
            PROTECTED_POST,
            headers={"Authorization": "Bearer test-token"},
        )
        _assert_not_csrf_failure(r)

    def test_bearer_lowercase_skips_csrf(self):
        """'bearer' (lowercase) also bypasses."""
        r = client.post(
            PROTECTED_POST,
            headers={"Authorization": "bearer test-token"},
        )
        _assert_not_csrf_failure(r)


class TestWhitelistedPaths:
    """Whitelisted paths bypass CSRF."""

    @pytest.mark.parametrize("path", [
        "/api/v1/auth",
        "/api/v1/interactive",
        "/api/v1/cron",
    ])
    def test_whitelisted_post_no_csrf_required(self, path):
        r = client.post(path)
        _assert_not_csrf_failure(r)

    def test_whitelisted_path_trailing_slash(self):
        """Path with trailing slash still matches whitelist."""
        r = client.post("/api/v1/auth/")
        _assert_not_csrf_failure(r)


class TestGetNotAffected:
    """GET requests don't require CSRF."""

    def test_get_passes_without_csrf(self):
        r = client.get("/api/v1/healthz")
        assert r.status_code == 200


class TestCrossOrigin:
    """Cross-origin requests are blocked by CORS."""

    def test_preflight_from_disallowed_origin_blocked(self):
        """OPTIONS preflight from non-allowed origin is rejected (400)."""
        r = client.options(
            PROTECTED_POST,
            headers={
                "Origin": "https://evil.com",
                "Access-Control-Request-Method": "POST",
            },
        )
        # Starlette CORSMiddleware returns 400 for disallowed origin preflight
        assert r.status_code == 400

    def test_preflight_from_allowed_origin_succeeds(self):
        """OPTIONS preflight from allowed origin returns 200."""
        r = client.options(
            PROTECTED_POST,
            headers={
                "Origin": "https://scanner.aldifhr.fun",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert r.status_code == 200
        assert r.headers.get("access-control-allow-origin") == "https://scanner.aldifhr.fun"

    def test_preflight_from_regex_matched_origin_succeeds(self):
        """Origin matching allow_origin_regex is allowed."""
        r = client.options(
            PROTECTED_POST,
            headers={
                "Origin": "https://app.aldifhr.fun",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert r.status_code == 200

    def test_actual_request_from_disallowed_origin_no_cors_header(self):
        """Non-preflight request from disallowed origin doesn't get CORS headers."""
        r = client.post(
            PROTECTED_POST,
            headers={"Origin": "https://evil.com"},
        )
        assert "access-control-allow-origin" not in r.headers
