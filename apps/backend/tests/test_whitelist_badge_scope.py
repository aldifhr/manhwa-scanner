"""Whitelist badge is per (title_key, source); dispatch stays cross-source.

Two rules that look contradictory but answer different questions:

  * BADGE (`map_result` in services/rss_query.py) — "is THIS source's row
    subscribed?" The badge is what the user reads before deciding to add a
    series, and it gates the Add button. A title tracked on shinigami must NOT
    show Verified on its voratoon row: that claimed a subscription the user
    never made, and hid the Add button so the row could never be added.

  * DISPATCH (`filter_whitelisted` in cron/collect.py) — "should we notify?"
    Deliberately cross-source: one series is one series, and FCFS
    (title+chapter, source-agnostic) picks the winner. Whichever source reports
    the chapter first notifies; the rest dedupe. Per-source matching here would
    delay a notification until the subscribed source happened to catch up.

A refactor that "unifies" these two will silently break one of them, so both
are pinned here.

Runs as a plain script (this repo has no pytest):
    PYTHONPATH=. python3 tests/test_whitelist_badge_scope.py
"""
import sys
from datetime import datetime, timezone

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _wl_map(rows):
    """Mirror rss_service's wl_map build (both raw and normalized keys)."""
    from app.utils.text import normalize_title_key

    m = {}
    for tk, src in rows:
        m[(normalize_title_key(tk), src)] = {"title_key": tk, "source": src}
        m[(tk, src)] = {"title_key": tk, "source": src}
    return m


@case
def badge_is_true_for_the_whitelisted_source():
    from app.services.rss_query import map_result

    wl = _wl_map([("absolute-dominion", "shinigami")])
    it = {"title_key": "absolute-dominion", "source": "shinigami", "title": "Absolute Dominion"}
    assert map_result(it, wl, {})["isWhitelisted"] is True


@case
def badge_is_false_for_a_different_source_with_the_same_title():
    """The regression that hid the Add button: a shinigami row made the
    voratoon/ikiru row look subscribed."""
    from app.services.rss_query import map_result

    wl = _wl_map([("absolute-dominion", "shinigami")])
    for other in ("ikiru", "voratoon"):
        it = {"title_key": "absolute-dominion", "source": other, "title": "Absolute Dominion"}
        got = map_result(it, wl, {})["isWhitelisted"]
        assert got is False, f"{other} row wrongly marked whitelisted (got {got})"


@case
def badge_is_true_once_that_source_is_also_added():
    """Same title on two sources = two rows, each Verified on its own source."""
    from app.services.rss_query import map_result

    wl = _wl_map([("absolute-dominion", "shinigami"), ("absolute-dominion", "voratoon")])
    for src in ("shinigami", "voratoon"):
        it = {"title_key": "absolute-dominion", "source": src, "title": "Absolute Dominion"}
        assert map_result(it, wl, {})["isWhitelisted"] is True


@case
def dispatch_still_matches_cross_source():
    """Cross-source is intentional on the dispatch path — fastest source wins,
    FCFS dedupes. Do not tighten this to per-source without the user asking."""
    from app.cron.collect import filter_whitelisted

    wl = [{"title_key": "absolute-dominion", "source": "shinigami"}]
    items = [
        {"title_key": "absolute-dominion", "source": "ikiru"},
        {"title_key": "absolute-dominion", "source": "voratoon"},
    ]
    kept = filter_whitelisted(items, wl)
    assert len(kept) == 2, f"cross-source dispatch should keep both, kept {len(kept)}"


@case
def dispatch_drops_unrelated_titles():
    from app.cron.collect import filter_whitelisted

    wl = [{"title_key": "absolute-dominion", "source": "shinigami"}]
    items = [{"title_key": "some-other-series", "source": "shinigami"}]
    assert filter_whitelisted(items, wl) == []


@case
def dispatch_matches_dashed_and_spaced_title_keys():
    """Scrapers have written both forms; slugify on both sides keeps them equal."""
    from app.cron.collect import filter_whitelisted

    wl = [{"title_key": "Absolute Dominion", "source": "shinigami"}]
    items = [{"title_key": "absolute-dominion", "source": "ikiru"}]
    assert len(filter_whitelisted(items, wl)) == 1


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
