"""Dispatch chapter sanity guard + the ceiling loader it depends on.

Two defects that compound, both live in production:

1. The ceiling never worked. `cur.fetchone()` returns a RealDictRow (the pool
   uses RealDictCursor) and the code read `_row[0]`, raising KeyError. The
   whole block sat inside `except Exception: pass`, so `_ceilings` stayed empty
   and the guard blocked nothing from the day it was written.

2. With the ceiling inert, nothing checked whether a chapter number was
   plausible. shinigami served chapter_number '26596' for a series whose real
   chapters are 1..266 (its own chapter list shows 26596 sitting beside 265),
   and it was dispatched — spamming the channel and poisoning the ceiling to
   26596, which then blocks every real chapter after it.

Fix 1 without fix 2 makes the poisoning worse, which is why they ship together.

These tests import the REAL functions. An earlier draft mirrored the logic and
therefore passed even with production reverted to the bug — a test that cannot
fail is not a guard.

    PYTHONPATH=. .venv/bin/python tests/test_dispatch_chapter_sanity.py
"""
import sys

sys.path.insert(0, ".")

PASSED = []
FAILED = []


def case(fn):
    try:
        fn()
        PASSED.append(fn.__name__)
    except AssertionError as e:
        FAILED.append((fn.__name__, str(e)))
    except Exception as e:  # noqa: BLE001
        FAILED.append((fn.__name__, f"{type(e).__name__}: {e}"))
    return fn


# ── the ceiling loader ──────────────────────────────────────────────────────

@case
def ceiling_loader_returns_a_real_value():
    """The regression: `_row[0]` on a RealDictRow raised KeyError, swallowed by
    a bare except, so every ceiling was missing and nothing was ever blocked."""
    from app.cron.dispatch_mod import load_chapter_ceilings

    c = load_chapter_ceilings([("the-apex-of-dragon-mastery", "voratoon")])
    assert ("the-apex-of-dragon-mastery", "voratoon") in c, (
        "ceiling missing — the loader is broken again (RealDictRow read as tuple?)"
    )
    assert c[("the-apex-of-dragon-mastery", "voratoon")] >= 266, c


@case
def ceiling_loader_is_cross_source():
    """The same value for every source of a title — the ceiling answers 'how
    far has this SERIES been notified', not 'how far on this site'."""
    from app.cron.dispatch_mod import load_chapter_ceilings

    c = load_chapter_ceilings([
        ("the-apex-of-dragon-mastery", "voratoon"),
        ("the-apex-of-dragon-mastery", "shinigami"),
    ])
    assert c[("the-apex-of-dragon-mastery", "voratoon")] == c[
        ("the-apex-of-dragon-mastery", "shinigami")
    ]


@case
def ceiling_loader_ignores_a_title_with_no_history():
    from app.cron.dispatch_mod import load_chapter_ceilings

    c = load_chapter_ceilings([("no-such-title-xyz-123", "shinigami")])
    assert ("no-such-title-xyz-123", "shinigami") not in c, c


@case
def ceiling_loader_handles_an_empty_input():
    from app.cron.dispatch_mod import load_chapter_ceilings

    assert load_chapter_ceilings([]) == {}


# ── the sanity guard ────────────────────────────────────────────────────────

@case
def sanity_blocks_the_26596_label():
    """The live case: real chapters 1..266, upstream labels one '26596'."""
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("26596", 266, batch_count=1) is True


@case
def sanity_allows_the_next_normal_chapter():
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("267", 266, batch_count=1) is False
    assert is_implausible_chapter("300", 266, batch_count=1) is False


@case
def sanity_allows_a_jump_below_the_big_number_band():
    """ch 30 -> ch 400 is accepted: the ceiling already answered 'is it new',
    so this guard only exists to catch absurd labels."""
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("400", 30, batch_count=1) is False


@case
def sanity_blocks_a_date_read_as_a_chapter():
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("20261008", 266, batch_count=1) is True


@case
def sanity_allows_a_three_chapter_renumber_burst():
    """4000/4001/4002 arriving together is a real renumber, not a bad label."""
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("4000", 3999, batch_count=3) is False
    assert is_implausible_chapter("4001", 3999, batch_count=3) is False


@case
def sanity_blocks_a_lone_absurd_number_even_when_close():
    """One item is not a renumber burst."""
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("4000", 3999, batch_count=1) is True


@case
def sanity_blocks_a_renumber_burst_that_is_far_from_the_ceiling():
    """3 items is not enough if they are wildly off — 26596 vs 266 is 26330 away."""
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("26596", 266, batch_count=3) is True


@case
def sanity_ignores_a_non_numeric_chapter():
    """'OVA' must not be treated as absurd; the ceiling ignores it too."""
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("OVA", 30, batch_count=1) is False


@case
def sanity_is_inert_without_a_ceiling():
    """No history yet means no basis to judge — never block a first chapter."""
    from app.cron.dispatch_mod import is_implausible_chapter

    assert is_implausible_chapter("26596", None, batch_count=1) is False


if __name__ == "__main__":
    for name, err in FAILED:
        print(f"FAIL {name}: {err}")
    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    sys.exit(1 if FAILED else 0)
