from __future__ import annotations

import json
import os
import logging
from app.config import settings

logger = logging.getLogger("tasks.queue")

QUEUE_KEY = "beag:tasks"
DLQ_KEY = "beag:tasks:dlq"
CRON_QUEUE_KEY = "beag:cron"

_redis = None


def _get_redis():
    global _redis
    if _redis is None:
        import redis
        _redis = redis.Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=None,
            retry_on_timeout=True,
        )
    return _redis


def enqueue_cron(action: str) -> None:
    """Push a cron pipeline job onto the Redis cron queue.

    The API process enqueues; a separate ROLE=cron worker pops and runs
    run_pipeline. If Redis is down the cron worker runs the pipeline inline.
    The API process does NOT fall back inline — it raises so the caller
    returns 503 instead of blocking the HTTP thread.
    """
    payload = {"action": action}
    try:
        _get_redis().rpush(CRON_QUEUE_KEY, json.dumps(payload))
        logger.info("enqueued cron job", action=action)
    except Exception as e:
        _role = (os.environ.get("ROLE") or "api").lower()
        if _role == "cron":
            logger.warn("enqueue cron failed (redis down), running inline", err=str(e)[:120], action=action)
            from app.tasks.lifecycle import run_cron_inline
            run_cron_inline(action)
        else:
            logger.warn("enqueue cron failed (redis down), API mode — returning error", err=str(e)[:120], action=action)
            raise


def enqueue_add(title: str, url: str, interaction: dict | None = None) -> None:
    """Push an add-to-whitelist job onto the Redis queue."""
    payload = {
        "kind": "add",
        "title": title,
        "url": url,
        "interaction": interaction or {},
        "attempts": 0,
    }
    try:
        _get_redis().rpush(QUEUE_KEY, json.dumps(payload))
        logger.info("enqueued add task", title=title)
    except Exception as e:
        logger.warn("enqueue failed (redis down), falling back to direct DB write", err=str(e)[:120], title=title)
        try:
            from app.tasks.lifecycle import do_add
            do_add(payload)
        except Exception as e2:
            logger.error("direct add fallback failed", exc=e2)
            raise
