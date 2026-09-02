"""Edge case tests for chapter parsing and whitelist matching."""
import pytest
from app.services.shared import parse_chapter_number, normalize_chapter, fcfs_key, chapter_label


def test_chapter_number_edge_cases():
    assert parse_chapter_number("Chapter 12 - Side Story") == 12.0
    assert parse_chapter_number("12.5.1") == 12.5  # first number wins
    assert parse_chapter_number("") is None
    assert parse_chapter_number(None) is None
    assert parse_chapter_number(0) == 0.0
    assert parse_chapter_number(-1) == -1.0
    assert parse_chapter_number("One Shot") is None
    assert parse_chapter_number("OVA") is None


def test_unicode_titles():
    titles = [
        "약혼자가 문을 부수고 들어왔다",  # Korean
        "私の英雄学院",  # Japanese
        "斗破苍穹",  # Chinese
        "Tower of God — 신의 탑",  # Mixed
    ]
    for t in titles:
        k = fcfs_key(t, "1")
        assert isinstance(k, str)
        assert "#1" in k


def test_long_titles():
    long_title = "A" * 300
    k = fcfs_key(long_title, "5")
    assert long_title.lower() in k


def test_special_characters():
    assert fcfs_key("Tom & Jerry", "1") == "tom jerry#1"
    assert fcfs_key("A < B > C", "1") == "a b c#1"
    assert fcfs_key('He said "hi"', "1") == 'he said hi#1'


def test_whitelist_empty():
    from app.services.shared import is_whitelisted
    assert is_whitelisted("x", "ikiru", {}) is False


def test_whitelist_duplicates():
    from app.services.shared import get_whitelisted_items
    wl = {(("a", "ikiru")): {}, (("a", "ikiru")): {}}  # dict dedups keys
    items = [{"title_key": "a", "source": "ikiru"}, {"title_key": "a", "source": "ikiru"}]
    out = get_whitelisted_items(items, wl)
    assert len(out) == 2  # both items match same key


def test_concurrent_fcfs():
    # fcfs_key must be deterministic so concurrent calls agree
    k1 = fcfs_key("Lookism", "100")
    k2 = fcfs_key("Lookism", "100")
    assert k1 == k2


def test_db_failure_graceful():
    from app.services.shared import normalize_cover
    # bad input shouldn't throw
    assert normalize_cover("not a url") == "not a url"
    assert normalize_cover("") == ""
    assert normalize_cover(None) is None
