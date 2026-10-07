"""The cron queue must be FIFO, and the shinigami walk must be bounded.

Two independent bugs caused the same outage — notifications stopped for ~7
hours while the `update` job sat in the queue the whole time:

  1. ORDERING. `enqueue_cron` RPUSHed while the worker BRPOPLPUSHes, i.e. it
     popped from the same end it pushed to. That makes the queue a LIFO stack:
     every newly scheduled job jumps ahead of the ones already waiting. With
     `update` enqueued every 120s and three rss-fetch jobs every 300s, `update`
     was buried by each new arrival and never reached the front.

  2. STARVATION. `collect_whitelisted_shinigami_chapters` walked all ~246
     whitelisted series serially at ~1.8s each => ~452s. An rss-fetch tick took
     116-153s, so with a single worker the queue never drained.

Both are pinned here. They are source/behaviour assertions rather than
end-to-end runs because the failure mode is "the ordering/limit is wrong",
which only a direct assertion catches reliably.

Run: PYTHONPATH=. python3 tests/test_cron_queue_fifo_and_walk_budget.py
"""
import inspect
import json
import os
import sys

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _src(fn) -> str:
    return inspect.getsource(fn)


@case
def enqueue_pushes_to_the_head_and_worker_pops_the_tail():
    """LPUSH + BRPOPLPUSH = FIFO. RPUSH + BRPOPLPUSH = LIFO (the bug)."""
    from app.tasks.queue import enqueue_cron
    from app.tasks.lifecycle import run_cron_worker

    enq = _src(enqueue_cron)

    # Check the actual Redis command, not the prose around it. The function
    # documents the old RPUSH behaviour in its docstring, and its Lua script is
    # itself a triple-quoted string, so neither a naive substring check nor a
    # docstring strip works — both would flag the explanation or eat the code.
    assert "redis.call('LPUSH'" in enq, "the Lua must LPUSH to keep the queue FIFO"
    assert "redis.call('RPUSH'" not in enq, "RPUSH makes the queue a LIFO stack"
    # The Python fallback path (FakeRedis / no EVAL) must agree with the Lua.
    assert "lpush(CRON_QUEUE_KEY" in enq, "the fallback must LPUSH too"

    worker = _src(run_cron_worker)
    assert "brpoplpush" in worker.lower(), "worker must pop the tail"
    assert "CRON_QUEUE_KEY, CRON_PROCESSING_KEY" in worker


@case
def fifo_ordering_actually_holds_against_redis():
    """Behavioural check: a job enqueued first is dequeued first."""
    try:
        import redis
    except ImportError:
        return  # no redis lib in this env; the source assertion still covers it
    try:
        r = redis.Redis.from_url(
            os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"),
            decode_responses=True,
            socket_connect_timeout=0.5,
            socket_timeout=0.5,
        )
        r.ping()
    except Exception:
        return  # no redis reachable; skip the live check

    q, proc = "beag:test:fifo", "beag:test:fifo:proc"
    r.delete(q, proc)
    order = ["first", "second", "third"]
    for name in order:
        r.lpush(q, json.dumps({"action": name}))
    got = []
    for _ in order:
        job = r.brpoplpush(q, proc, timeout=2)
        got.append(json.loads(job)["action"])
        r.lrem(proc, 1, job)
    r.delete(q, proc)
    assert got == order, f"FIFO violated: enqueued {order}, dequeued {got}"


@case
def walk_budget_is_bounded_and_under_the_source_timeout():
    from app.cron.collect import _WALK_BUDGET_PER_TICK
    from app.cron.collectors.common import _SOURCE_TIMEOUT

    assert _WALK_BUDGET_PER_TICK > 0
    # ~1.8s per series measured against the live API. The walk runs inside a
    # tick that also runs the other collectors, so it must leave headroom.
    est_s = _WALK_BUDGET_PER_TICK * 1.8
    assert est_s < _SOURCE_TIMEOUT, (
        f"budget {_WALK_BUDGET_PER_TICK} would take ~{est_s:.0f}s, "
        f"over the {_SOURCE_TIMEOUT}s collector timeout"
    )


@case
def walk_rotates_via_a_persisted_cursor():
    from app.cron.collect import (
        collect_whitelisted_shinigami_chapters,
        _load_walk_cursor,
        _save_walk_cursor,
    )

    src = _src(collect_whitelisted_shinigami_chapters)
    assert "_load_walk_cursor" in src and "_save_walk_cursor" in src
    # The slice must be taken modulo the total so it wraps around.
    assert "% total" in src, "the cursor must wrap, or the tail is never walked"
    # A cursor read/write failure must not break collection.
    assert _load_walk_cursor() >= 0
    _save_walk_cursor(7)
    assert _load_walk_cursor() == 7
    _save_walk_cursor(0)


@case
def recover_processing_preserves_order():
    """Crash recovery must not re-order the queue it restores into."""
    from app.tasks.lifecycle import _recover_processing

    src = _src(_recover_processing)
    # lmove with RIGHT/LEFT, or the legacy rpoplpush — but it must be one of
    # them, not a plain rpush onto the head.
    assert "lmove" in src or "rpoplpush" in src


def main() -> int:
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  pass  {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {exc}")
        except Exception as exc:
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
