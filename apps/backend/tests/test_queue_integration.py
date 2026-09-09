"""Integration tests for Redis cron queue: enqueue, dedup, clear, depth."""
import json
from unittest.mock import MagicMock, patch

import pytest

# Mock redis client shared across enqueue tests
_redis_mock = MagicMock()


@pytest.fixture(autouse=True)
def mock_redis(monkeypatch):
    """Patch _get_redis in app.tasks.queue and app.tasks.lifecycle."""
    _redis_mock.reset_mock()
    _redis_mock.lrange.return_value = []
    _redis_mock.rpush.return_value = 1
    _redis_mock.llen.return_value = 0
    _redis_mock.delete.return_value = 1

    with patch("app.tasks.queue._get_redis", return_value=_redis_mock), \
         patch("app.tasks.lifecycle._get_redis", return_value=_redis_mock), \
         patch("app.tasks._get_redis", return_value=_redis_mock):
        yield _redis_mock


def _auth_headers():
    return {"Authorization": "Bearer test-token"}


# ── enqueue_cron ─────────────────────────────────────────────────────


def test_enqueue_adds_job(mock_redis):
    from app.tasks.queue import enqueue_cron

    enqueue_cron("update")
    mock_redis.rpush.assert_called_once()
    args = mock_redis.rpush.call_args[0]
    assert args[0] == "beag:cron"
    assert json.loads(args[1]) == {"action": "update"}


def test_enqueue_with_source_and_title(mock_redis):
    from app.tasks.queue import enqueue_cron

    enqueue_cron("rss-fetch", source="ikiru", title="test")
    args = mock_redis.rpush.call_args[0]
    payload = json.loads(args[1])
    assert payload == {"action": "rss-fetch", "source": "ikiru", "title": "test"}


def test_enqueue_dedup_skips_duplicate(mock_redis):
    payload = json.dumps({"action": "update"})
    mock_redis.lrange.return_value = [payload]

    from app.tasks.queue import enqueue_cron
    enqueue_cron("update")
    mock_redis.rpush.assert_not_called()


def test_enqueue_dedup_allows_different_action(mock_redis):
    existing = json.dumps({"action": "update"})
    mock_redis.lrange.return_value = [existing]

    from app.tasks.queue import enqueue_cron
    enqueue_cron("rss-fetch", source="ikiru")
    mock_redis.rpush.assert_called_once()


def test_enqueue_no_title_when_empty(mock_redis):
    from app.tasks.queue import enqueue_cron

    enqueue_cron("update")
    payload = json.loads(mock_redis.rpush.call_args[0][1])
    assert "title" not in payload
    assert "source" not in payload


def test_enqueue_dedup_differentiates_source(mock_redis):
    existing = json.dumps({"action": "rss-fetch", "source": "ikiru"})
    mock_redis.lrange.return_value = [existing]

    from app.tasks.queue import enqueue_cron
    enqueue_cron("rss-fetch", source="shinigami")
    mock_redis.rpush.assert_called_once()


# ── DELETE /api/v1/queue/cron ────────────────────────────────────────


def test_clear_cron_endpoint_deletes_queue(mock_redis):
    mock_redis.llen.return_value = 5
    with patch("app.api.queue_dashboard.require_monitor_auth", return_value=True):
        from app.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        r = client.delete("/api/v1/queue/cron", headers=_auth_headers())
    assert r.status_code == 200
    data = r.json()
    assert data["success"] is True
    assert data["data"]["deleted"] == 5
    mock_redis.delete.assert_called_once_with("beag:cron")


def test_clear_cron_unauthorized():
    # Bad bearer token bypasses CSRF, then require_monitor_auth returns False → 401
    with patch("app.api.queue_dashboard.require_monitor_auth", return_value=False):
        from app.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        r = client.delete("/api/v1/queue/cron", headers={"Authorization": "Bearer bad-token"})
    assert r.status_code == 401


# ── GET /api/v1/queue/status (depth) ─────────────────────────────────


def test_queue_status_depth_counts(mock_redis):
    mock_redis.llen.side_effect = [3, 7, 3, 7]
    with patch("app.api.queue_dashboard.require_monitor_auth", return_value=True):
        from app.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        r = client.get("/api/v1/queue/status", headers=_auth_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["data"]["depth"] == 10
    assert body["data"]["depths"]["main_queue"] == 3
    assert body["data"]["depths"]["cron_queue"] == 7


def test_queue_status_depth_empty(mock_redis):
    mock_redis.llen.side_effect = [0, 0, 0, 0]
    with patch("app.api.queue_dashboard.require_monitor_auth", return_value=True):
        from app.main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        r = client.get("/api/v1/queue/status", headers=_auth_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["depth"] == 0
    assert body["data"]["depths"]["cron_queue"] == 0
