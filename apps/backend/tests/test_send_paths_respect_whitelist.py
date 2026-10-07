"""Every send path must respect the whitelist.

There are three ways a chapter reaches Discord, and only ONE of them used to
check the whitelist:

  1. `dispatch()` (cron/dispatch_mod.py) — reached via pipeline.py, which calls
     `filter_whitelisted()` first. OK.
  2. `retry_failed_dispatches()` (services/dispatch/retry.py) — re-sent whatever
     was parked in failed_dispatches, with no whitelist check. A `failed_dispatches`
     row can outlive the whitelist entry that produced it (the user unsubscribes
     while a send is parked), so a removed series kept notifying. FIXED.
  3. `gap_detector` auto-backfill — iterates whitelist rows, so its input is
     already scoped. OK.

This pins #2 so it cannot regress. The tests are source-level (they read the
function body) because exercising the real path needs a live DB, a Discord
stub and a backdated row — that end-to-end probe is documented in the skill's
reference file.

Runs as a plain script (this repo has no pytest):
    PYTHONPATH=. python3 tests/test_send_paths_respect_whitelist.py
"""
import inspect

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _src(fn) -> str:
    return inspect.getsource(fn)


@case
def retry_path_checks_the_whitelist():
    from app.services.dispatch.retry import retry_failed_dispatches

    src = _src(retry_failed_dispatches)
    assert "whitelist" in src, "retry must consult the whitelist"
    assert "skipped_unsubscribed" in src, "retry must track skipped-unsubscribed rows"


@case
def retry_fails_closed_when_the_whitelist_cannot_be_loaded():
    """Without the whitelist we cannot distinguish a live subscription from a
    cancelled one. Sending to a cancelled one is the bug, so skip the pass."""
    from app.services.dispatch.retry import retry_failed_dispatches

    src = _src(retry_failed_dispatches)
    assert "Fail CLOSED" in src, "the whitelist-load failure must fail closed"
    # and it must return before the send loop
    load_at = src.find("whitelist load failed")
    send_at = src.find("send_channel_message")
    assert load_at != -1 and send_at != -1 and load_at < send_at


@case
def retry_uses_the_same_matching_rule_as_dispatch():
    """retry and normal dispatch must agree on what 'subscribed' means, or one
    notifies for something the other drops.

    Both are source-strict on (title_key, source) — see filter_whitelisted().
    """
    from app.services.dispatch.retry import retry_failed_dispatches
    from app.cron.collect import filter_whitelisted

    r_src = _src(retry_failed_dispatches)
    f_src = _src(filter_whitelisted)
    assert "slugify_title_key" in r_src and "slugify_title_key" in f_src
    # Both must key on the PAIR, not the title alone: matching on the title
    # sent notifications from sources nobody subscribed to.
    assert "wl_pairs" in r_src, "retry must gate on (title_key, source)"
    assert "(wk, src)" in f_src, "filter_whitelisted must gate on (title_key, source)"


@case
def dispatch_entrypoint_still_requires_a_whitelist_filter_upstream():
    """pipeline.py is what makes dispatch() safe; if that call disappears the
    raw dispatch path sends anything it is handed."""
    import app.cron.pipeline as pl
    import pathlib

    src = pathlib.Path(pl.__file__).read_text()
    assert "filter_whitelisted" in src, "pipeline must filter before dispatch"
    assert "to_dispatch" in src


@case
def gap_detector_reads_its_gaps_from_the_whitelist():
    """gap_detector's input is whitelist-scoped; keep it that way."""
    import pathlib
    import app.cron.gap_detector as gd

    src = pathlib.Path(gd.__file__).read_text()
    assert "table('whitelist')" in src or 'table("whitelist")' in src, (
        "detect_gaps must iterate whitelist rows"
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
