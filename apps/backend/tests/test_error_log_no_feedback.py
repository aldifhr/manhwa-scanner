"""insert_error must not feed the logger that feeds it.

The logger queues every warn/error and its worker calls insert_error(). When
insert_error() failed and logged that failure through the same logger, each
failure queued another failure: 140,641 lines in ~5 minutes while the DB
circuit was open, all of them the same warning.

    PYTHONPATH=. python3 tests/test_error_log_no_feedback.py
"""
import io
import sys
from unittest import mock

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def a_failing_insert_does_not_recurse_through_the_logger():
    from app.storage import error_logs as el

    buf = io.StringIO()
    el._LAST_WARN = 0.0
    with mock.patch.object(sys, "stderr", buf), mock.patch.object(
        el, "get_supabase", side_effect=RuntimeError("circuit db OPEN - fast fail")
    ), mock.patch.object(el.logger, "warn") as logged:
        for _ in range(500):
            el.insert_error(message="boom")
        assert not logged.called, "insert_error reported through the app logger again (feedback loop)"


@case
def repeated_failures_are_rate_limited():
    from app.storage import error_logs as el

    buf = io.StringIO()
    el._LAST_WARN = 0.0
    with mock.patch.object(sys, "stderr", buf), mock.patch.object(
        el, "get_supabase", side_effect=RuntimeError("circuit db OPEN")
    ):
        for _ in range(1000):
            el.insert_error(message="boom")
    lines = buf.getvalue().count("\n")
    assert lines == 1, f"expected one line per minute, got {lines}"


def main():
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  pass  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {e}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
