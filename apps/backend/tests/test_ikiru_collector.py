"""Ikiru collector contract.

Two things about ikiru bite silently, so both are pinned here:

1. Timestamps. The API labels WIB wall-clock (UTC+7) with a `Z` suffix. Parsing
   that string as UTC puts every chapter seven hours in the FUTURE, and the
   freshness window then either drops everything or admits stale re-touches.
   `parse_ikiru_ts` must shift by -7h; a regression here is invisible in the
   logs and only shows up as missing notifications.

2. URL shape. dispatch() reads "url" and filters it through VALID_URL_PREFIXES.
   An ikiru chapter URL that does not match `{IKIRU_PUBLIC_BASE}/manga/` is
   dropped as junk with no error above debug level.

Runs as a plain script (this repo has no pytest):
    PYTHONPATH=. python3 tests/test_ikiru_collector.py
"""
import sys
from datetime import datetime, timedelta, timezone

from app.config import settings

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def timestamps_are_shifted_out_of_the_future():
    """A WIB-labeled 'Z' stamp must land in the past, not 7h ahead."""
    from app.scrapers.ikiru import parse_ikiru_ts

    now = datetime.now(timezone.utc)
    # ikiru reports "now" as wall-clock WIB with a Z. Raw parse = +7h.
    wib_now = (now + timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    parsed = parse_ikiru_ts(wib_now)
    assert parsed is not None, "parser returned None for a valid stamp"
    assert parsed.tzinfo is not None, "parser must return an aware datetime"
    drift = abs((parsed - now).total_seconds())
    assert drift < 120, f"expected ~now, drifted {drift/3600:.2f}h"
    assert parsed <= now + timedelta(minutes=1), "timestamp still in the future"


@case
def unparseable_and_empty_timestamps_return_none():
    from app.scrapers.ikiru import parse_ikiru_ts

    assert parse_ikiru_ts(None) is None
    assert parse_ikiru_ts("") is None
    assert parse_ikiru_ts("not-a-date") is None


@case
def chapter_and_series_urls_use_the_public_base():
    from app.scrapers.ikiru import _chapter_url, _series_url

    base = settings.IKIRU_PUBLIC_BASE.rstrip("/")
    # HYPHEN, not slash — /chapter/12 is a 404 on the live site.
    assert _chapter_url("some-slug", 12) == f"{base}/manga/some-slug/chapter-12"
    assert _series_url("some-slug") == f"{base}/manga/some-slug"


@case
def dispatch_accepts_ikiru_chapter_urls():
    """The junk guard must not treat an ikiru chapter URL as foreign."""
    from app.cron.dispatch_mod import dispatch

    base = settings.IKIRU_PUBLIC_BASE.rstrip("/")
    item = {
        "title": "Ikiru Probe",
        "title_key": "ikiru-probe",
        "chapter": "1",
        "chapter_num": 1.0,
        "url": f"{base}/manga/ikiru-probe/chapter/1",
        "chapter_url": f"{base}/manga/ikiru-probe/chapter/1",
        "source": "ikiru",
        "cover": "https://cdn.ikiru.id/featured/x.png",
        "series_url": f"{base}/manga/ikiru-probe",
        "origin": "KR",
        "updated_time": datetime.now(timezone.utc).isoformat(),
        "type": "manhwa",
    }
    # dry_run short-circuits before the send; a junk-filtered item returns 0.
    sent = dispatch([item], ["000000000000000000"], "t-ikiru", dry_run=True, force=True)
    assert sent == 1, f"ikiru URL was filtered as junk (sent={sent})"


@case
def type_map_covers_every_catalogue_shelf():
    from app.scrapers.ikiru import TYPE_TO_ORIGIN

    assert TYPE_TO_ORIGIN["MANHWA"] == ("manhwa", "KR")
    assert TYPE_TO_ORIGIN["MANHUA"] == ("manhua", "CN")
    assert TYPE_TO_ORIGIN["MANGA"] == ("manga", "JP")


@case
def ikiru_is_a_registered_source():
    from app.config import CRON_ACTIONS, VALID_SOURCES

    assert "ikiru" in VALID_SOURCES
    assert "ikiru" in settings.SOURCE_KEYS
    assert "rss-fetch:ikiru" in CRON_ACTIONS
    assert "cdn.ikiru.id:443" in settings.get_proxy_hosts()


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
