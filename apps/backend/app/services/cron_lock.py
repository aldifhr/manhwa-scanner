"""Cron job idempotency — Redis lock to prevent duplicate processing."""
from __future__ import annotations

import time
from functools import wraps
from typing import Callable, Optional

from app.logger import get_logger

logger = get_logger("cron:lock")


def with_redis_lock(lock_key: str, ttl: int = 300):
    """Decorator that acquires a Redis lock before running a cron job.
    
    Returns False if lock already held (job already running).
    Returns True if job completed.
    Returns None if Redis unavailable (job should run anyway).
    """
    def decorator(fn: Callable):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            from app.tasks.queue import _get_redis
            try:
                r = _get_redis()
                if not r:
                    logger.debug("cron lock: redis unavailable, running anyway", fn=fn.__name__)
                    return fn(*args, **kwargs)
                
                # Try to acquire lock
                acquired = r.set(f"cron:lock:{lock_key}", "1", nx=True, ex=ttl)
                if not acquired:
                    logger.info("cron lock: already running, skipping", fn=fn.__name__)
                    return False
                
                try:
                    result = fn(*args, **kwargs)
                    return result
                finally:
                    # Release lock
                    r.delete(f"cron:lock:{lock_key}")
            except Exception as e:
                logger.warn("cron lock: error, running anyway", fn=fn.__name__, err=str(e)[:120])
                return fn(*args, **kwargs)
        
        return wrapper
    return decorator


def clear_redis_lock(lock_key: str) -> None:
    """Clear a stale lock (e.g., after crash)."""
    try:
        from app.tasks.queue import _get_redis
        r = _get_redis()
        if r:
            r.delete(f"cron:lock:{lock_key}")
    except Exception:
        pass
