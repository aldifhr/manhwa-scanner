"""Unit tests for app/services/resilience.py."""
import pytest
import time
from app.services.resilience import retry_with_backoff, CircuitBreaker, with_circuit_breaker


def test_retry_success_first_try():
    @retry_with_backoff(max_retries=3)
    def f():
        return "ok"
    assert f() == "ok"


def test_retry_eventual_success():
    calls = {"n": 0}

    @retry_with_backoff(max_retries=3, base_delay=0.01, max_delay=0.05)
    def f():
        calls["n"] += 1
        if calls["n"] < 2:
            raise ValueError("boom")
        return "ok"
    assert f() == "ok"
    assert calls["n"] == 2


def test_retry_exhaustion():
    calls = {"n": 0}

    @retry_with_backoff(max_retries=2, base_delay=0.01, max_delay=0.02)
    def f():
        calls["n"] += 1
        raise RuntimeError("always fails")
    with pytest.raises(RuntimeError):
        f()
    assert calls["n"] == 3  # initial + 2 retries


def test_circuit_breaker_closed():
    cb = CircuitBreaker("t1", failure_threshold=3, recovery_timeout=0.1)

    @cb
    def f():
        return 1
    assert f() == 1
    assert cb.state.value == "closed"


def test_circuit_breaker_opens():
    cb = CircuitBreaker("t2", failure_threshold=2, recovery_timeout=0.1)

    @cb
    def f():
        raise RuntimeError("x")
    for _ in range(2):
        with pytest.raises(RuntimeError):
            f()
    assert cb.state.value == "open"


def test_circuit_breaker_open_fast_fail():
    cb = CircuitBreaker("t3", failure_threshold=1, recovery_timeout=10)

    @cb
    def f():
        raise RuntimeError("x")
    with pytest.raises(RuntimeError):
        f()
    # now open
    with pytest.raises(RuntimeError, match="OPEN"):
        f()


def test_circuit_breaker_half_open_recovery():
    cb = CircuitBreaker("t4", failure_threshold=1, recovery_timeout=0.05, success_threshold=1)

    @cb
    def f():
        raise RuntimeError("x")
    with pytest.raises(RuntimeError):
        f()
    assert cb.state.value == "open"
    time.sleep(0.1)  # let recovery timeout elapse
    assert cb.state.value == "half_open"

    @cb
    def g():
        return "recovered"
    assert g() == "recovered"
    assert cb.state.value == "closed"


def test_circuit_breaker_half_open_failure():
    cb = CircuitBreaker("t5", failure_threshold=1, recovery_timeout=0.05, success_threshold=2)

    @cb
    def f():
        raise RuntimeError("x")
    with pytest.raises(RuntimeError):
        f()
    time.sleep(0.1)
    assert cb.state.value == "half_open"
    with pytest.raises(RuntimeError):
        f()  # fails again in half-open
    assert cb.state.value == "open"
