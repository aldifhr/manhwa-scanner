"""Pytest configuration and basic smoke tests."""
import pytest
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_healthz():
    """Health endpoint returns 200."""
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_rss_requires_auth():
    """RSS feed is intentionally PUBLIC (user: 'buka public aja').
    This test now asserts it does NOT require auth."""
    r = client.get("/api/v1/rss")
    assert r.status_code == 200


def test_rss_with_auth():
    """RSS feed returns 200 with valid token."""
    import os
    token = os.getenv("MONITOR_AUTH_TOKEN", "")
    if not token:
        pytest.skip("MONITOR_AUTH_TOKEN not set")
    r = client.get("/api/v1/rss", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert "data" in body


def test_rss_new_with_auth():
    """RSS new endpoint returns count."""
    import os
    token = os.getenv("MONITOR_AUTH_TOKEN", "")
    if not token:
        pytest.skip("MONITOR_AUTH_TOKEN not set")
    r = client.get("/api/v1/rss/new?since=2026-01-01&distinct=title", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert "newCount" in body["data"]


def test_whitelist_requires_auth():
    """Whitelist endpoint requires authentication."""
    r = client.get("/api/v1/whitelist")
    assert r.status_code == 401


def test_cron_requires_auth():
    """Cron endpoint requires authentication."""
    r = client.get("/api/v1/cron?action=update")
    assert r.status_code == 401
