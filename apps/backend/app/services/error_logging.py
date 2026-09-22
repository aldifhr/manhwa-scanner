"""Structured error logging — consistent error format across all scrapers."""
from __future__ import annotations

import traceback
from functools import wraps
from typing import Callable, Optional

from app.logger import get_logger

logger = get_logger("error")


def log_error(
    scope: str,
    msg: str,
    exc: Optional[Exception] = None,
    *,
    error_type: Optional[str] = None,
    url: Optional[str] = None,
    attempt: Optional[int] = None,
    extra: Optional[dict] = None,
) -> dict:
    """Log structured error and return error dict for FE/health reporting."""
    
    exc_type = error_type or (type(exc).__name__ if exc else "unknown")
    exc_msg = str(exc)[:200] if exc else ""
    
    log_data = {
        "scope": scope,
        "error_type": exc_type,
        "error_msg": str(exc_msg)[:200] if exc_msg else "",
    }
    if url:
        log_data["url"] = url
    if attempt is not None:
        log_data["attempt"] = attempt
    if extra:
        log_data.update(extra)
    
    # Include full traceback for ReadTimeout/ConnectError
    if isinstance(exc, (TimeoutError, ConnectionError, OSError)):
        log_data["traceback"] = traceback.format_exc()[:2000]
    
    logger.error(msg, **log_data)
    
    return {
        "error_type": exc_type,
        "error_msg": exc_msg,
        "url": url,
        "timestamp": None,  # caller can fill
    }


def with_error_logging(scope: str):
    """Decorator that catches exceptions and logs them with structured format."""
    def decorator(fn: Callable):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception as e:
                log_error(scope, f"{fn.__name__} failed", exc=e)
                raise
        return wrapper
    return decorator
