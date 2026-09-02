"""Redis caching layer for manhwa-backend."""
from __future__ import annotations

import json
import hashlib
from functools import wraps
from typing import Any, Callable

from app.logger import get_logger

logger = get_logger("redis_cache")

# Cache TTLs (seconds)
CACHE_TTLS = {
    "whitelist": 30,
    "catalog": 60,
    "stats": 30,
    "analytics": 60,
    "rss": 30,
    "health": 15,
    "dashboard": 30,
}


def _get_redis():
    """Get Redis client (lazy import)."""
    import redis
    from app.config import settings
    return redis.Redis.from_url(
        settings.REDIS_URL,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
    )


def cache_get(key: str) -> Any | None:
    """Get cached value."""
    try:
        r = _get_redis()
        data = r.get(key)
        if data:
            return json.loads(data)
    except Exception as e:
        logger.warn("cache get failed", err=str(e)[:100])
    return None


def cache_set(key: str, value: Any, ttl: int = 60) -> bool:
    """Set cached value."""
    try:
        r = _get_redis()
        r.setex(key, ttl, json.dumps(value, default=str))
        return True
    except Exception as e:
        logger.warn("cache set failed", err=str(e)[:100])
    return False


def cache_delete(key: str) -> bool:
    """Delete cached key."""
    try:
        r = _get_redis()
        r.delete(key)
        return True
    except Exception as e:
        logger.warn("cache delete failed", err=str(e)[:100])
    return False


def cache_delete_pattern(pattern: str) -> int:
    """Delete all keys matching pattern."""
    try:
        r = _get_redis()
        keys = r.keys(pattern)
        if keys:
            r.delete(*keys)
        return len(keys)
    except Exception as e:
        logger.warn("cache delete pattern failed", err=str(e)[:100])
    return 0


def cached(prefix: str, ttl: int = 60, key_func: Callable = None):
    """Decorator for caching function results."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            # Generate cache key
            if key_func:
                cache_key = f"{prefix}:{key_func(*args, **kwargs)}"
            else:
                # Default: hash of args + kwargs
                key_data = f"{args}:{sorted(kwargs.items())}"
                cache_key = f"{prefix}:{hashlib.md5(key_data.encode()).hexdigest()}"
            
            # Try cache first
            cached_value = cache_get(cache_key)
            if cached_value is not None:
                return cached_value
            
            # Call function
            result = func(*args, **kwargs)
            
            # Cache result
            cache_set(cache_key, result, ttl)
            
            return result
        return wrapper
    return decorator


def invalidate_cache(prefix: str) -> int:
    """Invalidate all cache keys with given prefix."""
    return cache_delete_pattern(f"{prefix}:*")
