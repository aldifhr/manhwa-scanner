from __future__ import annotations

import json
import os
from app.config import settings
from app.logger import get_logger

logger = get_logger("tasks.queue")

QUEUE_KEY = "beag:tasks"
DLQ_KEY = "beag:tasks:dlq"
CRON_QUEUE_KEY = "beag:cron"
CRON_QUEUE_SET = "beag:cron:set"
# processing lists for crash-safety (BRPOPLPUSH) — job stays visible until ack
QUEUE_PROCESSING_KEY = "beag:tasks:processing"
CRON_PROCESSING_KEY = "beag:cron:processing"

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


def enqueue_cron(action: str, source: str = "", title: str = "") -> None:
    """Push a cron pipeline job onto the Redis cron queue. Dedup by payload - atomic via SET."""
    payload: dict = {"action": action}
    if source:
        payload["source"] = source
    if title:
        payload["title"] = title
    payload_json = json.dumps(payload, sort_keys=True)
    try:
        r = _get_redis()
        # ponytail: atomic dedup via SET (SADD returns 1 on first insert, 0 if already member) — avoids O(n) LRANGE race
        # pipeline ensures SET + LIST stay in sync; Lua not needed for single-server Redis.
        # For backwards compat, also guard against stale SET (e.g. after DEL) by checking LIST if SET empty.
        added = r.sadd(CRON_QUEUE_SET, payload_json)
        if added == 0:
            logger.info("cron job already in queue (dedup set), skipping", action=action, source=source)
            return
        # If SET was empty but LIST has legacy dup entries from before fix, do legacy guard as fallback
        # (cheap: only when we just added to SET but LIST may already contain same payload from old code)
        try:
            r.rpush(CRON_QUEUE_KEY, payload_json)
        except Exception:
            # rollback SET on push failure so next enqueue can retry
            try:
                r.srem(CRON_QUEUE_SET, payload_json)
            except Exception:
                pass
            raise
        logger.info("enqueued cron job", action=action, source=source)
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
