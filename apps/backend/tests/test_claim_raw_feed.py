"""The claim queue must feed BOTH feeds, and must never widen to the whole window.

Two failures this locks down:

  1. `claim_recent_chapters_for_dispatch()` used `JOIN whitelist`, so only
     whitelisted series could ever be claimed. The raw feed — which exists for
     series that are NOT whitelisted — had no candidates, ever. The single-feed
     behaviour was baked into the queue, not just into routing.
  2. When the claim came back empty, pipeline.py fell back to
     `get_recent_chapters(hours=24)` — the entire 24h window, already-sent
     rows included. Every run logged `to_send: 92, sent: 0` and looked alive
     while dispatching nothing new.

Both are source-level here because the repo runs plain scripts (no pytest) and
the claim path needs a live Postgres to execute.

    PYTHONPATH=. python3 tests/test_claim_raw_feed.py
"""
import inspect

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def claim_select_does_not_require_a_whitelist_row():
    from app.services import claim

    src = inspect.getsource(claim.claim_recent_chapters_for_dispatch)
    assert "LEFT JOIN whitelist" in src, "claim still inner-joins whitelist: raw feed starves"
    assert "JOIN whitelist w" not in src.replace("LEFT JOIN whitelist w", ""), "inner join remains"


@case
def claim_select_drops_the_python_whitelist_gate():
    from app.services import claim

    src = inspect.getsource(claim.claim_recent_chapters_for_dispatch)
    assert "not in allowed" not in src, "Python allowlist still filters non-whitelisted rows out"


@case
def disabled_sources_are_still_skipped():
    from app.services import claim

    src = inspect.getsource(claim.claim_recent_chapters_for_dispatch)
    assert "if src in _disabled:" in src, "disabled source would be claimed and notified"


@case
def pipeline_never_falls_back_to_the_whole_window():
    from app.cron import pipeline

    src = inspect.getsource(pipeline.run_pipeline)
    assert "get_recent_chapters(hours=24)" not in src, (
        "empty claim falls back to the 24h window again — the to_send:92/sent:0 bug"
    )

@case
def failed_retries_never_broadcast_to_raw():
    from app.services.dispatch import retry as retry_mod

    src = inspect.getsource(retry_mod.retry_failed_dispatches)
    assert "split_dispatch_targets(channels)" in src, "retry path doesn't split feed channels"
    assert "for ch in _wl_ch:" in src, "whitelist retry still sends to raw channel"
    assert "for ch in channels:" not in src, "retry still broadcasts to every feed"


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
