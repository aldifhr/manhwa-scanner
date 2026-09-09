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
    """Push a cron pipeline job onto the Redis cron queue. Dedup by payload - atomic via MULTI/EXEC."""
    payload: dict = {"action": action}
    if source:
        payload["source"] = source
    if title:
        payload["title"] = title
    payload_json = json.dumps(payload, sort_keys=True)
    try:
        r = _get_redis()
        # ponytail: MULTI/EXEC makes SADD+RPUSH+EXPIRE atomic — no phantom SET entry on crash between them
        # EXPIRE gives whole set 24h TTL — safety net for any entries orphan cleanup misses
        pipe = r.pipeline(transaction=True)
        pipe.sadd(CRON_QUEUE_SET, payload_json)
        pipe.rpush(CRON_QUEUE_KEY, payload_json)
        pipe.expire(CRON_QUEUE_SET, 86400)
        results = pipe.execute()
        added = results[0]  # SADD returns 1 if new, 0 if already member
        if added == 0:
            # Duplicate detected — undo our RPUSH to keep queue clean
            try:
                r.rpop(CRON_QUEUE_KEY)
            except Exception:
                pass
            logger.info("cron job already in queue (dedup set), skipping", action=action, source=source)
            return
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


def _cleanup_orphaned_set_entries() -> None:
    """Remove SET entries no longer present in CRON_QUEUE_KEY (phantom dedup cleanup)."""
    try:
        r = _get_redis()
        queue_members = set(r.lrange(CRON_QUEUE_KEY, 0, -1) or [])
        set_members = r.smembers(CRON_QUEUE_SET)
        orphaned = set_members - queue_members
        if orphaned:
            r.srem(CRON_QUEUE_SET, *orphaned)
            logger.info("cleaned orphaned dedup set entries", count=len(orphaned))
    except Exception as e:
        logger.warn("orphan cleanup failed", err=str(e)[:120])


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
