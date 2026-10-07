"""The dispatch watchdog must catch a silent outage, and stay quiet otherwise.

Motivation: the July outage ran for ~7 hours with every source reporting
HEALTHY and no notification leaving the box. Nothing alerted, because nothing
was watching the pipeline itself — only the sources.

Two conditions, both grounded in the same `fcfs_key` the dispatcher uses:

  1. liveness — the pipeline's own heartbeat (cron_run_status) went stale
  2. delivery — a whitelisted chapter inside the window with no ledger entry

The liveness source matters: an earlier version keyed off
dispatch_history.sent_at, which fires on a healthy system whenever no chapter
happens to be new. That false positive is why the heartbeat is used instead.

Run: PYTHONPATH=. python3 tests/test_dispatch_watchdog.py
"""
import inspect

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _src(fn) -> str:
    return inspect.getsource(fn)


@case
def liveness_uses_the_heartbeat_not_the_ledger():
    """dispatch_history.sent_at is silent when nothing is new — a healthy state.
    cron_run_status is written every tick, so staleness there means the
    pipeline actually stopped."""
    from app.cron.dispatch_watchdog import check_dispatch_starvation

    src = _src(check_dispatch_starvation)
    assert "cron_run_status" in src, "liveness must read the pipeline heartbeat"
    assert "MAX(sent_at)" not in src, (
        "sent_at fires on a healthy system when no chapter is new"
    )


@case
def undelivered_check_uses_the_real_fcfs_key():
    """A hand-rolled key disagrees with the dispatcher and yields false
    positives — that mistake is why this test exists."""
    from app.cron.dispatch_watchdog import check_dispatch_starvation

    src = _src(check_dispatch_starvation)
    assert "from app.services.fcfs import fcfs_key" in src, (
        "must use the canonical key, not a local reimplementation"
    )
    assert "title_key||" not in src and "title_key ||" not in src, (
        "must not hand-roll the key in SQL"
    )


@case
def undelivered_check_is_source_strict():
    """Matching on the title alone would count chapters from sources nobody
    subscribed to — the same bug that was fixed in filter_whitelisted()."""
    from app.cron.dispatch_watchdog import check_dispatch_starvation

    src = _src(check_dispatch_starvation)
    assert "w.source = rc.source" in src, "the whitelist join must be per source"


@case
def thresholds_are_sane_against_the_schedules():
    from app.cron.dispatch_watchdog import STARVE_AFTER_MIN, UNDELIVERED_AFTER_MIN

    # The scheduler enqueues `update` every 2 min, so both thresholds must be
    # well clear of a couple of missed cycles.
    assert STARVE_AFTER_MIN >= 10, "too tight: would fire on a transient hiccup"
    assert UNDELIVERED_AFTER_MIN >= 5, "too tight: would fire on a normal delay"
    # ...but still fast enough to be useful.
    assert STARVE_AFTER_MIN <= 120, "too loose to catch an outage promptly"


@case
def alerts_are_cooldown_limited_and_state_clears():
    """One alert per condition per window, and the cooldown must reset when the
    condition clears so the NEXT incident is not suppressed."""
    from app.cron.dispatch_watchdog import check_dispatch_starvation, COOLDOWN_MIN

    src = _src(check_dispatch_starvation)
    assert "_should_alert" in src, "alerts must go through the cooldown gate"
    assert "_clear_alert_state" in src, "state must reset when healthy"
    assert COOLDOWN_MIN >= 15, "cooldown too short: would spam"

    from app.cron.dispatch_watchdog import _should_alert, _clear_alert_state

    # Behavioural: first call passes the gate, second is suppressed, and
    # clearing re-arms it.
    probe = "test-cooldown-probe"
    _clear_alert_state(probe)
    first = _should_alert(probe)
    second = _should_alert(probe)
    _clear_alert_state(probe)
    third = _should_alert(probe)
    _clear_alert_state(probe)
    assert first is True, "first alert should fire"
    assert second is False, "second alert inside the window must be suppressed"
    assert third is True, "after clearing, the next incident must alert again"


@case
def a_broken_redis_does_not_silence_the_watchdog():
    """A duplicate alert beats a silent outage."""
    from app.cron.dispatch_watchdog import _should_alert
    import app.cron.dispatch_watchdog as wd

    orig = wd._redis

    def boom():
        raise RuntimeError("redis down")

    wd._redis = boom
    try:
        assert _should_alert("redis-down-probe") is True
    finally:
        wd._redis = orig


@case
def missing_heartbeat_is_not_treated_as_an_outage():
    """A fresh install has no rows; that is not an incident."""
    from app.cron.dispatch_watchdog import check_dispatch_starvation

    src = _src(check_dispatch_starvation)
    assert "no heartbeat yet" in src, "an empty heartbeat table must be skipped"


@case
def the_action_is_wired_into_the_cron_worker():
    """The watchdog is useless if nothing calls it."""
    from app.tasks.lifecycle import run_cron_inline
    import app.tasks.scheduler as sched

    lifecycle_src = _src(run_cron_inline)
    assert "dispatch-watchdog" in lifecycle_src, "action not handled in lifecycle"

    sched_src = inspect.getsource(sched)
    assert "dispatch-watchdog" in sched_src, "action not scheduled"
    assert sched._DISPATCH_WATCHDOG_INTERVAL_S <= 600, (
        "must run often enough to catch an outage inside STARVE_AFTER_MIN"
    )


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
