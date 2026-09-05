"""Resilience primitives: retry-with-backoff and circuit breaker.

Implemented from scratch (no external deps). Used by scraper, dispatch,
and storage layers to survive transient upstream failures without
adding any rate limiting on inbound traffic.
"""
from __future__ import annotations

import random
import threading
import time
from enum import Enum
from functools import wraps
from typing import Callable, Optional

from app.logger import get_logger

logger = get_logger("services:resilience")


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


def retry_with_backoff(
    max_retries: int = 3,
    base_delay: float = 0.5,
    max_delay: float = 10.0,
    backoff_factor: float = 2.0,
    jitter: bool = True,
):
    """Retry a function with exponential backoff + jitter.

    Jitter uses random.uniform(0, 1) so concurrent callers don't sync up.
    Logs every retry attempt.
    """

    def decorator(fn: Callable):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            last_exc: Optional[Exception] = None
            for attempt in range(max_retries + 1):
                try:
                    return fn(*args, **kwargs)
                except Exception as e:  # noqa: BLE001 - we retry on any transient error
                    last_exc = e
                    if attempt >= max_retries:
                        break
                    delay = min(base_delay * (backoff_factor ** attempt), max_delay)
                    if jitter:
                        delay = delay * (0.5 + random.uniform(0, 1))
                    logger.warn(
                        "retry",
                        fn=fn.__name__,
                        attempt=f"{attempt + 1}/{max_retries}",
                        delay=f"{delay:.2f}s",
                        err=str(e)[:120],
                    )
                    time.sleep(delay)
            logger.error("retry_exhausted", fn=fn.__name__, err=str(last_exc)[:160])
            raise last_exc

        return wrapper

    return decorator


class CircuitBreaker:
    """Simple circuit breaker.

    CLOSED  → normal, counts failures
    OPEN    → fails fast, rejects calls until recovery_timeout elapses
    HALF_OPEN → allows one probe call; success closes, failure re-opens
    """

    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout: float = 60.0,
        success_threshold: int = 2,
    ):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.success_threshold = success_threshold
        self._state = CircuitState.CLOSED
        self._failures = 0
        self._successes = 0
        self._opened_at = 0.0
        self._lock = threading.RLock()

    @property
    def state(self) -> CircuitState:
        with self._lock:
            if self._state == CircuitState.OPEN:
                if time.monotonic() - self._opened_at >= self.recovery_timeout:
                    self._state = CircuitState.HALF_OPEN
                    self._successes = 0
                    logger.info("circuit_half_open", name=self.name)
            return self._state

    def allow(self) -> bool:
        """Return True if call is allowed, transitioning state as needed."""
        with self._lock:
            s = self.state
            if s == CircuitState.OPEN:
                return False
            return True

    def record_success(self):
        with self._lock:
            if self._state == CircuitState.HALF_OPEN:
                self._successes += 1
                if self._successes >= self.success_threshold:
                    self._state = CircuitState.CLOSED
                    self._failures = 0
                    self._successes = 0
                    logger.info("circuit_closed", name=self.name)
            else:
                self._failures = 0

    def record_failure(self):
        with self._lock:
            if self._state == CircuitState.HALF_OPEN:
                self._state = CircuitState.OPEN
                self._opened_at = time.monotonic()
                logger.debug("circuit_open", name=self.name, reason="half_open_failure")
                return
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._state = CircuitState.OPEN
                self._opened_at = time.monotonic()
                logger.debug("circuit_open", name=self.name, reason="threshold")

    def __call__(self, fn: Callable):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not self.allow():
                raise RuntimeError(f"circuit {self.name} OPEN — fast fail")
            try:
                result = fn(*args, **kwargs)
                self.record_success()
                return result
            except Exception:
                self.record_failure()
                raise

        return wrapper


# Shared circuit breakers (module-level singletons)
cb_discord = CircuitBreaker("discord", failure_threshold=5, recovery_timeout=60)
cb_db = CircuitBreaker("db", failure_threshold=3, recovery_timeout=30)
cb_ikiru = CircuitBreaker("ikiru", failure_threshold=5, recovery_timeout=120)
# Shinigami (2026-08-30): tightened from failure_threshold=5/recovery=120 so the
# breaker trips earlier on a 429 burst and stays OPEN longer (5min) — prevents an
# immediate re-burst right after recovery that would just 429 again.
cb_shinigami = CircuitBreaker("shinigami", failure_threshold=3, recovery_timeout=300)
# Voratoon (2026-08-30): added so the reader health endpoint + status page
# report voratoon circuit state alongside ikiru/shinigami. Voratoon's API is
# stable but rate-limits (429) under burst, so a moderate threshold.
cb_voratoon = CircuitBreaker("voratoon", failure_threshold=5, recovery_timeout=120)
# ApiFailureDetector merged here — ikiru API → HTML fallback (threshold 5, cooldown 300)
# ponytail: reuse CircuitBreaker (shared threshold 5/cooldown 300), per-scraper tuning if 429 profile diverges — split cb_ikiru_api config when shinigami/voratoon needs different window
cb_ikiru_api = CircuitBreaker("ikiru_api", failure_threshold=5, recovery_timeout=300)


def with_circuit_breaker(cb: CircuitBreaker):
    """Decorator that wraps a function with a given CircuitBreaker."""

    def decorator(fn: Callable):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not cb.allow():
                raise RuntimeError(f"circuit {cb.name} OPEN — fast fail")
            try:
                result = fn(*args, **kwargs)
                cb.record_success()
                return result
            except Exception:
                cb.record_failure()
                raise

        return wrapper

    return decorator
