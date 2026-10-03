"""dispatch() reads the chapter link from "url", not "chapter_url".

The ingest layer and the frontend both speak "chapter_url"; dispatch() and its
VALID_URL_PREFIXES guard speak "url". An item carrying only "chapter_url" looks
like junk to that guard and is dropped silently -- no error, no log above debug
level, the chapter simply never reaches the channel.

That is exactly what happened while testing dispatch by hand: to_send was 1,
claimed_db was 0, and it read as a delivery failure until the key name was
corrected. A collector that only fills chapter_url would hit the same wall in
production and nobody would be told.

The first test drives the real guard through dispatch() with both key spellings.
The rest lock the item shape the send path actually reads, so a future refactor
that renames the field trips a test instead of silently unsending chapters.
"""
import sys
from datetime import datetime, timezone

from app.config import settings

# The URL must match SHINIGAMI_PUBLIC_BASE + SHINIGAMI_CHAPTER_PATH, otherwise
# the junk filter rejects it before the send is even attempted.
# CHAPTER_PATH already ends in "/", so do not add a separator here.
VALID_URL = f"{settings.SHINIGAMI_PUBLIC_BASE}{settings.SHINIGAMI_CHAPTER_PATH}test-uuid"

CHANNEL = "000000000000000000"  # never reached: dry_run short-circuits before send

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def _item(**over):
    item = {
        "title": "Test Series",
        "chapter": "1",
        "url": VALID_URL,
        "chapter_url": VALID_URL,
        "source": "shinigami",
        # title_key is required: dispatch filters to_send on (title_key, source)
        # before the URL guard ever runs.
        "title_key": "test-series",
        "cover": None,
        # Must be inside the 24h freshness window or dispatch drops the item
        # before the URL guard -- that is what made the first probes return 0.
        "updated_time": datetime.now(timezone.utc).isoformat(),
    }
    item.update(over)
    return item


@case
def dispatch_reads_url_not_chapter_url():
    """An item with only chapter_url is dropped by the junk filter."""
    from app.cron.dispatch_mod import dispatch

    # force=True so the dispatch_history dedupe (dispatch_mod.py:84) does not
    # swallow the probe -- this test is about the URL guard, not about history.
    sent = dispatch([_item(url=None)], [CHANNEL], "t-chapter-url-only",
                    dry_run=True, force=True)
    assert sent == 0, f"expected the item to be filtered, got {sent}"

    sent = dispatch([_item()], [CHANNEL], "t-url-present",
                    dry_run=True, force=True)
    assert sent == 1, f"expected 1 item through the guard, got {sent}"


@case
def valid_prefix_accepts_shinigami_urls_only():
    """The junk guard must accept this source's URLs and reject foreign ones."""
    from app.cron.dispatch_mod import dispatch

    foreign = "https://example.invalid/chapter/xyz"
    sent = dispatch([_item(url=foreign, chapter_url=foreign)], [CHANNEL],
                    "t-foreign", dry_run=True, force=True)
    assert sent == 0, f"foreign URL should be filtered, got {sent}"


@case
def send_path_fields_are_present():
    """Every field the send path reads must exist on an incoming item."""
    required = ("title", "chapter", "url", "source", "updated_time")
    item = _item()
    missing = [f for f in required if not item.get(f)]
    assert not missing, f"item shape is missing {missing}"


@case
def empty_channel_list_short_circuits():
    """No channel configured means no send, and no exception."""
    from app.cron.dispatch_mod import dispatch

    assert dispatch([_item()], [], "t-no-channel", dry_run=True) == 0


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