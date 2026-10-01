"""Ingest contract: every collector field must survive into the table row.

The bug this guards against: `origin` was normalized into `_norm`, then dropped
when the row dict was rebuilt from an allowlist, and nothing re-added it. Every
row landed with origin=NULL and the country flag vanished from the feed with no
error anywhere. This asserts the whole field set, not just origin, so the same
class of drop is caught for any field.

Written without pytest because the backend venv has no test runner installed
and adding one is not worth it for a single module. Run it directly:

    PYTHONPATH=. .venv/bin/python tests/test_recent_chapters_ingest.py
"""
from datetime import datetime, timedelta, timezone

from app.storage.recent_chapters_ingest import (
    ALLOWED_FIELDS,
    normalize_recent_chapter_rows,
)

NOW = datetime.now(timezone.utc).isoformat()
_OLD = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()


def row(**over):
    base = {
        "chapter_url": "https://x/series/y/chapter/1",
        "title_key": "y",
        "title": "Y",
        "chapter": "1",
        "chapter_num": 1,
        "source": "shinigami",
        "cover": "https://c/1.jpg",
        "series_url": "https://x/series/y",
        "updated_time": NOW,
        "release_date": NOW,
        "origin": "KR",
        "description": "desc",
        "type": "manhwa",
        "genres": ["Action"],
        "rating": 8.0,
    }
    base.update(over)
    return base


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def every_allowed_field_reaches_the_output():
    """No collector field may be dropped by the row rebuild."""
    cleaned, _ = normalize_recent_chapter_rows([row()])
    assert len(cleaned) == 1, cleaned
    missing = ALLOWED_FIELDS - set(cleaned[0])
    assert not missing, f"fields dropped before insert: {sorted(missing)}"


@case
def origin_is_written_not_dropped():
    """Regression: origin was computed, then excluded from the row dict."""
    cleaned, _ = normalize_recent_chapter_rows([row(origin="KR")])
    assert cleaned[0]["origin"] == "KR"


@case
def origin_falls_back_to_type_when_raw_is_empty():
    cleaned, _ = normalize_recent_chapter_rows([row(origin="", type="manhwa")])
    assert cleaned[0]["origin"] == "KR"


@case
def origin_normalizes_every_format():
    for fmt, expected in (("manhwa", "KR"), ("manga", "JP"), ("manhua", "CN")):
        cleaned, _ = normalize_recent_chapter_rows([row(origin="", type=fmt)])
        assert cleaned[0]["origin"] == expected, f"{fmt} -> {cleaned[0]['origin']}"


@case
def whitelist_origin_wins_over_payload():
    cleaned, _ = normalize_recent_chapter_rows(
        [row(origin="", type="manhwa")], {("y", "shinigami"): "JP"}
    )
    assert cleaned[0]["origin"] == "JP"


@case
def numeric_fields_default_to_float():
    cleaned, _ = normalize_recent_chapter_rows([row(rating=None, chapter_num=None)])
    assert cleaned[0]["rating"] == 0.0
    assert cleaned[0]["chapter_num"] == 0.0


@case
def unparseable_numeric_becomes_zero_not_an_exception():
    cleaned, _ = normalize_recent_chapter_rows([row(rating="not-a-number")])
    assert cleaned[0]["rating"] == 0.0


@case
def genres_default_to_empty_list():
    cleaned, _ = normalize_recent_chapter_rows([row(genres=None)])
    assert cleaned[0]["genres"] == []


@case
def rows_without_chapter_url_are_skipped():
    cleaned, skipped = normalize_recent_chapter_rows([row(chapter_url="")])
    assert cleaned == []
    assert not skipped, "a missing url is a skip, not an invalid-date skip"


@case
def invalid_release_date_falls_back_to_updated_time():
    cleaned, _ = normalize_recent_chapter_rows([row(release_date="soon")])
    assert cleaned[0]["release_date"] == NOW


@case
def no_usable_date_is_reported_per_source():
    cleaned, skipped = normalize_recent_chapter_rows(
        [row(release_date="", updated_time=""), row(chapter_url="https://x/2")]
    )
    assert len(cleaned) == 1
    assert skipped.get("shinigami") == 1


@case
def empty_input():
    cleaned, skipped = normalize_recent_chapter_rows([])
    assert cleaned == [] and skipped == {}


@case
def old_but_valid_release_date_is_kept():
    """Age is a query concern, not an ingest concern."""
    cleaned, skipped = normalize_recent_chapter_rows(
        [row(release_date=_OLD, updated_time=_OLD)]
    )
    assert len(cleaned) == 1 and not skipped


def main() -> int:
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  pass  {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {exc}")
    print(f"\n{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
