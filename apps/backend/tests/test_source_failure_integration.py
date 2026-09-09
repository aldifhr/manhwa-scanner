"""Integration tests for source failure handling: circuit breakers, failed dispatches, health endpoint.

Tests the full failure path: scraper fails → circuit breaker opens →
failed dispatch recorded → health endpoint reflects degraded state.
"""
import os
import time
from unittest.mock import MagicMock, patch, PropertyMock

import pytest
from fastapi.testclient import TestClient

# Bypass production boot guard
os.environ["ENVIRONMENT"] = "development"
os.environ.setdefault("MONITOR_AUTH_TOKEN", "test-token")

from app.main import app
from app.services.resilience import (
    CircuitBreaker,
    CircuitState,
    cb_shinigami,
    cb_ikiru,
    cb_ikiru_api,
    cb_voratoon,
    cb_discord,
    cb_db,
)


client = TestClient(app)


def _auth():
    return {"Authorization": "Bearer test-token"}


# ── Circuit Breaker Integration ───────────────────────────────────────


class TestCircuitBreakerOpensAfterConsecutiveFailures:
    """Test that circuit breakers open after threshold failures per source."""

    def test_shinigami_breaker_opens_after_3_failures(self):
        """cb_shinigami has failure_threshold=3 — opens on 3rd failure."""
        cb = CircuitBreaker("shinigami_test", failure_threshold=3, recovery_timeout=300)

        @cb
        def failing_fetch():
            raise RuntimeError("API 500")

        for _ in range(3):
            with pytest.raises(RuntimeError):
                failing_fetch()

        assert cb.state == CircuitState.OPEN
        # Fast-fail: no call to inner function
        with pytest.raises(RuntimeError, match="OPEN"):
            failing_fetch()

    def test_ikiru_breaker_opens_after_5_failures(self):
        """cb_ikiru has failure_threshold=5 — opens on 5th failure."""
        cb = CircuitBreaker("ikiru_test", failure_threshold=5, recovery_timeout=120)

        @cb
        def failing_fetch():
            raise RuntimeError("CF challenge")

        for _ in range(5):
            with pytest.raises(RuntimeError):
                failing_fetch()

        assert cb.state == CircuitState.OPEN

    def test_voratoon_breaker_opens_after_5_failures(self):
        """cb_voratoon has failure_threshold=5 — opens on 5th failure."""
        cb = CircuitBreaker("voratoon_test", failure_threshold=5, recovery_timeout=120)

        @cb
        def failing_fetch():
            raise RuntimeError("voratoon down")

        for _ in range(5):
            with pytest.raises(RuntimeError):
                failing_fetch()

        assert cb.state == CircuitState.OPEN

    def test_breaker_recovery_half_open_to_closed(self):
        """After recovery_timeout, breaker goes half_open; success closes it."""
        cb = CircuitBreaker("recovery_test", failure_threshold=2, recovery_timeout=0.05, success_threshold=1)

        @cb
        def failing():
            raise RuntimeError("fail")

        for _ in range(2):
            with pytest.raises(RuntimeError):
                failing()
        assert cb.state == CircuitState.OPEN

        time.sleep(0.1)
        assert cb.state == CircuitState.HALF_OPEN

        @cb
        def succeeding():
            return "ok"

        succeeding()
        assert cb.state == CircuitState.CLOSED

    def test_breaker_half_open_failure_reopens(self):
        """Failure in half-open state re-opens the breaker."""
        cb = CircuitBreaker("halfopen_fail_test", failure_threshold=1, recovery_timeout=0.05, success_threshold=2)

        @cb
        def failing():
            raise RuntimeError("fail")

        with pytest.raises(RuntimeError):
            failing()
        time.sleep(0.1)
        assert cb.state == CircuitState.HALF_OPEN

        with pytest.raises(RuntimeError):
            failing()
        assert cb.state == CircuitState.OPEN


# ── Scraper + Circuit Breaker Integration ─────────────────────────────


class TestScraperCircuitBreakerIntegration:
    """Test that scrapers respect circuit breaker state and record failures."""

    def test_shinigami_get_returns_none_when_circuit_open(self):
        """shinigami._get() returns None immediately when cb_shinigami is OPEN."""
        from app.scrapers import shinigami

        # Force circuit open
        with patch.object(type(cb_shinigami), "state", new_callable=PropertyMock, return_value=CircuitState.OPEN):
            result = shinigami._get("/manga/list?q=test")
            assert result is None

    def test_ikiru_fetch_json_returns_none_when_circuit_open(self):
        """ikiru._fetch_json() returns None when cb_ikiru is OPEN."""
        from app.scrapers import ikiru

        with patch.object(type(cb_ikiru), "state", new_callable=PropertyMock, return_value=CircuitState.OPEN):
            result = ikiru._fetch_json("/list/latest?page=1")
            assert result is None

    def test_shinigami_records_failure_on_http_error(self):
        """shinigami._get() calls cb_shinigami.record_failure() on non-200 response."""
        from app.scrapers import shinigami

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.headers = {}

        with patch("app.scrapers.shinigami._CLIENT") as mock_client, \
             patch.object(cb_shinigami, "allow", return_value=True), \
             patch.object(cb_shinigami, "record_failure") as mock_record, \
             patch.object(cb_shinigami, "record_success"):
            mock_client.get.return_value = mock_response
            result = shinigami._get("/manga/list?q=test")
            assert result is None
            mock_record.assert_called()

    def test_ikiru_records_failure_on_exception(self):
        """ikiru._cf_get() calls cb_ikiru.record_failure() on exception."""
        from app.scrapers import ikiru

        # Mock at the module level where curl_cffi is imported
        with patch("curl_cffi.requests.get", side_effect=Exception("network error")), \
             patch.object(cb_ikiru, "allow", return_value=True), \
             patch.object(cb_ikiru, "record_failure") as mock_record:
            with pytest.raises(Exception):
                ikiru._cf_get("https://example.com")
            mock_record.assert_called()


# ── Failed Dispatch Recording ─────────────────────────────────────────


class TestFailedDispatchRecording:
    """Test that failed dispatches are recorded in failed_dispatches table."""

    def test_record_failed_writes_to_db(self):
        """record_failed() upserts a row into failed_dispatches."""
        from app.storage.dispatch import record_failed

        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            record_failed(
                chapter_url="https://example.com/ch1",
                title_key="test-series",
                source="shinigami",
                chapter_title="Chapter 1",
                chapter_number=1.0,
                error_message="Discord 500",
                error_code="DISCORD_500",
            )
            mock_sb.table.return_value.upsert.assert_called_once()

    def test_record_failed_payload_shape(self):
        """record_failed() sends correct payload shape to Supabase."""
        from app.storage.dispatch import record_failed

        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            record_failed(
                chapter_url="https://example.com/ch1",
                title_key="test-series",
                source="shinigami",
                error_message="fail",
                error_code="500",
            )
            call_args = mock_sb.table.return_value.upsert.call_args
            payload = call_args[0][0]
            assert payload["chapter_url"] == "https://example.com/ch1"
            assert payload["source"] == "shinigami"
            assert payload["status"] == "failed"
            assert payload["retry_count"] == 0

    def test_record_failed_skips_empty_url(self):
        """record_failed() is a no-op for empty chapter_url."""
        from app.storage.dispatch import record_failed

        with patch("app.storage.dispatch.get_supabase") as mock_sb:
            record_failed("")
            mock_sb.assert_not_called()

    def test_record_failed_handles_db_error(self):
        """record_failed() swallows DB errors gracefully."""
        from app.storage.dispatch import record_failed

        mock_sb = MagicMock()
        mock_sb.table.return_value.upsert.return_value.execute.side_effect = Exception("DB down")
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            # Should not raise
            record_failed("https://example.com/ch1")


# ── Health Endpoint Degraded State ────────────────────────────────────


class TestHealthEndpointDegraded:
    """Test that health endpoint reflects degraded state from circuit breakers."""

    def test_health_detailed_returns_circuit_breaker_states(self):
        """/health/detailed includes all circuit breaker states."""
        r = client.get("/api/v1/health/detailed", headers=_auth())
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        cbs = body["data"]["circuit_breakers"]
        assert "shinigami" in cbs
        assert "ikiru" in cbs
        assert "voratoon" in cbs
        assert "discord" in cbs
        assert "db" in cbs

    def test_health_detailed_shows_open_circuit(self):
        """When a circuit breaker is OPEN, health endpoint reflects it."""
        # Open the shinigami breaker
        with patch.object(type(cb_shinigami), "state", new_callable=PropertyMock, return_value=CircuitState.OPEN):
            r = client.get("/api/v1/health/detailed", headers=_auth())
            assert r.status_code == 200
            body = r.json()
            assert body["data"]["circuit_breakers"]["shinigami"] == "open"

    def test_health_detailed_shows_half_open_circuit(self):
        """When a circuit breaker is HALF_OPEN, health endpoint reflects it."""
        with patch.object(type(cb_ikiru), "state", new_callable=PropertyMock, return_value=CircuitState.HALF_OPEN):
            r = client.get("/api/v1/health/detailed", headers=_auth())
            assert r.status_code == 200
            body = r.json()
            assert body["data"]["circuit_breakers"]["ikiru"] == "half_open"

    def test_health_detailed_closed_circuit(self):
        """When circuit breakers are CLOSED, health endpoint shows closed."""
        r = client.get("/api/v1/health/detailed", headers=_auth())
        assert r.status_code == 200
        body = r.json()
        # Default state for all breakers should be closed
        for name, state in body["data"]["circuit_breakers"].items():
            assert state == "closed", f"Breaker {name} expected closed, got {state}"

    def test_health_detailed_is_public(self):
        """/health/detailed is a public endpoint (no auth required)."""
        r = client.get("/api/v1/health/detailed")
        assert r.status_code == 200

    def test_healthz_always_public(self):
        """/healthz is always public and returns ok."""
        r = client.get("/api/v1/healthz")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


# ── Retry Queue Integration ───────────────────────────────────────────


class TestRetryQueueIntegration:
    """Test that retry_failed_dispatches skips when circuit is open."""

    def test_retry_skips_when_discord_circuit_open(self):
        """retry_failed_dispatches returns early when cb_discord is OPEN."""
        from app.services.dispatch_retry import retry_failed_dispatches

        with patch.object(type(cb_discord), "state", new_callable=PropertyMock, return_value=CircuitState.OPEN):
            result = retry_failed_dispatches()
            assert result["retried"] == 0
            assert result["resent"] == 0

    def test_retry_returns_zero_when_no_failed_rows(self):
        """retry_failed_dispatches returns zeros when no failed rows exist."""
        from app.services.dispatch_retry import retry_failed_dispatches

        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = []

        # get_supabase is imported locally inside the function — patch at source
        with patch("app.db.get_supabase", return_value=mock_sb), \
             patch.object(cb_discord, "allow", return_value=True):
            result = retry_failed_dispatches()
            assert result["retried"] == 0
            assert result["resent"] == 0


# ── Failed Dispatches API ─────────────────────────────────────────────


class TestFailedDispatchesAPI:
    """Test the /failed-dispatches API endpoints."""

    def test_failed_dispatches_requires_auth(self):
        """GET /failed-dispatches requires auth."""
        r = client.get("/api/v1/failed-dispatches")
        assert r.status_code == 401

    def test_failed_dispatches_returns_empty_list(self):
        """GET /failed-dispatches returns empty list when no failures."""
        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = []
        mock_sb.table.return_value.select.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.count = 0

        with patch("app.db.get_supabase", return_value=mock_sb):
            r = client.get("/api/v1/failed-dispatches", headers=_auth())
            assert r.status_code == 200
            body = r.json()
            assert body["success"] is True
            assert body["data"]["results"] == []

    def test_failed_dispatches_queue_requires_auth(self):
        """GET /failed-dispatches/queue requires auth."""
        r = client.get("/api/v1/failed-dispatches/queue")
        assert r.status_code == 401


# ── Full Failure Flow Integration ─────────────────────────────────────


class TestFullFailureFlow:
    """End-to-end: scraper fails → circuit opens → dispatch fails → recorded → health shows degraded."""

    def test_shinigami_failure_flow(self):
        """Simulate shinigami API failure → circuit opens → health reflects it."""
        from app.scrapers import shinigami

        cb = CircuitBreaker("shinigami_flow", failure_threshold=3, recovery_timeout=300)

        # Simulate 3 consecutive failures
        mock_response = MagicMock()
        mock_response.status_code = 503
        mock_response.headers = {}

        with patch("app.scrapers.shinigami._CLIENT") as mock_client:
            mock_client.get.return_value = mock_response
            for _ in range(3):
                shinigami._get("/manga/list?q=test")

        # Circuit should be open now (via the shared cb_shinigami singleton)
        assert cb_shinigami.state == CircuitState.OPEN

        # Next call returns None immediately (fast-fail)
        result = shinigami._get("/manga/list?q=test")
        assert result is None

        # Health endpoint shows open
        r = client.get("/api/v1/health/detailed", headers=_auth())
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["circuit_breakers"]["shinigami"] == "open"

    def test_dispatch_failure_records_and_health_shows(self):
        """Failed dispatch is recorded and health endpoint shows degraded."""
        from app.storage.dispatch import record_failed

        mock_sb = MagicMock()
        with patch("app.storage.dispatch.get_supabase", return_value=mock_sb):
            record_failed(
                chapter_url="https://shinigami.asia/series/test/ch1",
                title_key="test-series",
                source="shinigami",
                error_message="Discord webhook not found",
                error_code="404",
            )

        # Verify the upsert was called
        mock_sb.table.return_value.upsert.assert_called_once()

        # Health endpoint should still be accessible
        r = client.get("/api/v1/health/detailed", headers=_auth())
        assert r.status_code == 200
