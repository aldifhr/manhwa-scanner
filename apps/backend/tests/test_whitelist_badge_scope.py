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
    voratoon row look subscribed."""
    from app.services.rss_query import map_result

    wl = _wl_map([("absolute-dominion", "shinigami")])
    it = {"title_key": "absolute-dominion", "source": "voratoon", "title": "Absolute Dominion"}
    got = map_result(it, wl, {})["isWhitelisted"]
    assert got is False, f"voratoon row wrongly marked whitelisted (got {got})"


@case
def badge_is_true_once_that_source_is_also_added():
    """Same title on two sources = two rows, each Verified on its own source."""
    from app.services.rss_query import map_result

    wl = _wl_map([("absolute-dominion", "shinigami"), ("absolute-dominion", "voratoon")])
    for src in ("shinigami", "voratoon"):
        it = {"title_key": "absolute-dominion", "source": src, "title": "Absolute Dominion"}
        assert map_result(it, wl, {})["isWhitelisted"] is True


@case
def dispatch_is_source_strict():
    """Dispatch must NOT fire for a source that is not subscribed.

    This test used to assert the opposite ("cross-source is intentional on the
    dispatch path"), which locked in a real bug: 18 of 160 dispatches were for
    a (title, source) pair absent from the whitelist, so a voratoon embed
    arrived for a series the user only tracked on shinigami — and the
    per-source badge on /whitelist disagreed with the notification.

    The whitelist has one row per (title_key, source); matching it per source
    is what makes the badge and the notification tell the same story.
    """
    from app.cron.collect import filter_whitelisted

    wl = [{"title_key": "absolute-dominion", "source": "shinigami"}]
    items = [
        {"title_key": "absolute-dominion", "source": "voratoon"},
        {"title_key": "absolute-dominion", "source": "shinigami"},
    ]
    kept = filter_whitelisted(items, wl)
    assert len(kept) == 1, f"only the subscribed source may dispatch, kept {len(kept)}"
    assert kept[0]["source"] == "shinigami"


@case
def dispatch_matches_when_every_source_is_subscribed():
    """A series carried by two sources and subscribed on both dispatches twice."""
    from app.cron.collect import filter_whitelisted

    wl = [
        {"title_key": "absolute-dominion", "source": "shinigami"},
        {"title_key": "absolute-dominion", "source": "voratoon"},
    ]
    items = [
        {"title_key": "absolute-dominion", "source": "shinigami"},
        {"title_key": "absolute-dominion", "source": "voratoon"},
    ]
    kept = filter_whitelisted(items, wl)
    assert len(kept) == 2, f"both subscribed sources should keep, kept {len(kept)}"
    assert {k["source"] for k in kept} == {"shinigami", "voratoon"}


@case
def dispatch_is_case_insensitive_on_source():
    """Whitelist rows and scraped items must not disagree on case."""
    from app.cron.collect import filter_whitelisted

    wl = [{"title_key": "absolute-dominion", "source": "Voratoon"}]
    items = [{"title_key": "absolute-dominion", "source": "voratoon"}]
    assert len(filter_whitelisted(items, wl)) == 1


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
    items = [{"title_key": "absolute-dominion", "source": "shinigami"}]
    assert len(filter_whitelisted(items, wl)) == 1


@case
def manga_path_does_not_contribute_a_title_key():
    """The retired ikiru path shape (slug drops apostrophes: a-gods-ascension)
    while the collector keys off the title (a-god-s-ascension). Adopting the URL
    slug would create a row that can never match a scraped chapter, so the series
    would look whitelisted and silently never notify. The helper must refuse it
    and let the title decide — the guard stays even though the source is gone."""
    from app.services.whitelist_service import _derive_title_key_from_url

    url = "https://09.ikiru.wtf/manga/a-gods-ascension"
    got = _derive_title_key_from_url(url, "A God's Ascension")
    assert got == "", f"a /manga/ URL must not yield a key, got {got!r}"
    assert got != "a-gods-ascension", "must not adopt the apostrophe-less slug"


@case
def empty_url_falls_through_to_the_title():
    from app.services.whitelist_service import _derive_title_key_from_url

    assert _derive_title_key_from_url("", "The Player Hides His Past") == ""


@case
def generic_url_uses_its_last_segment():
    from app.services.whitelist_service import _derive_title_key_from_url

    # NB: a "/series/" path is the shinigami branch and needs a UUID, so use a
    # path that does not collide with a known source shape.
    got = _derive_title_key_from_url("https://example.com/titles/some-title", "ignored")
    assert got == "some-title", f"got {got!r}"


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
