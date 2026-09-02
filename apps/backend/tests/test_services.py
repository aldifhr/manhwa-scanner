"""Unit tests for app/services/shared.py."""
import pytest
from app.services.shared import (
    parse_chapter_number, normalize_chapter, fcfs_key, chapter_label,
    normalize_cover, whitelist_key, is_whitelisted, get_whitelisted_items,
)


def test_parse_chapter_number_variants():
    assert parse_chapter_number("Chapter 12.5") == 12.5
    assert parse_chapter_number("ch12") == 12.0
    assert parse_chapter_number("One Shot") is None
    assert parse_chapter_number(None) is None
    assert parse_chapter_number(12) == 12.0
    assert parse_chapter_number(12.50) == 12.5
    assert parse_chapter_number("Vol.3 Ch.45") == 3.0  # first number in string
    assert parse_chapter_number("") is None


def test_normalize_chapter():
    assert normalize_chapter("12.5") == "12.5"
    assert normalize_chapter("12.50") == "12.5"
    assert normalize_chapter("160-2") == "160.2"
    assert normalize_chapter("160.2") == "160.2"
    assert normalize_chapter("OVA") == "OVA"
    assert normalize_chapter("Extra") == "Extra"
    assert normalize_chapter("") == ""
    assert normalize_chapter(None) == ""


def test_fcfs_key():
    assert fcfs_key("The Great Ruler", "326") == "the great ruler#326"
    assert fcfs_key("The Great Ruler", "326") == fcfs_key("THE GREAT RULER", "326")
    # HTML entities
    assert fcfs_key("Academy's", "1") == fcfs_key("Academy&#8217;s", "1")
    # trailing punctuation stripped
    assert fcfs_key("Lookism!", "5") == "lookism#5"


def test_chapter_label():
    assert chapter_label("ch12.5") == "Chapter 12.5"
    assert chapter_label("12") == "Chapter 12"
    assert chapter_label("ch 12 - Side Story") == "Chapter 12 - Side Story"
    assert chapter_label("") == ""
    assert chapter_label("OVA") == "OVA"
    assert chapter_label("Chapter 50 Special") == "Chapter 50 - Special"


def test_normalize_cover():
    # passthrough http(s)
    assert normalize_cover("https://x.com/a.jpg") == "https://x.com/a.jpg"
    assert normalize_cover("http://x.com/a.jpg") == "http://x.com/a.jpg"
    # proxy wrapper (already full https URL) is returned as-is
    proxy = "https://scanner.aldifhr.fun/api/reader/proxy?url=https%3A%2F%2Fx.com%2Fa.jpg"
    assert normalize_cover(proxy) == proxy
    # bare proxy path (no scheme) gets unwrapped
    bare = "/api/reader/proxy?url=https%3A%2F%2Fx.com%2Fa.jpg"
    assert normalize_cover(bare) == "https://x.com/a.jpg"
    # None
    assert normalize_cover(None) is None


def test_whitelist_key():
    from app.utils.text import normalize_title_key
    k = whitelist_key("Lookism", "shinigami")
    assert k == (normalize_title_key("Lookism"), "shinigami")


def test_is_whitelisted():
    wl = {(("lookism", "shinigami")): {"title": "Lookism"}}
    assert is_whitelisted("lookism", "shinigami", wl) is True
    assert is_whitelisted("nope", "shinigami", wl) is False


def test_get_whitelisted_items():
    wl = {(("lookism", "shinigami")): {}, (("tower", "ikiru")): {}}
    items = [
        {"title_key": "lookism", "source": "shinigami"},
        {"title_key": "tower", "source": "ikiru"},
        {"title_key": "nope", "source": "ikiru"},
    ]
    out = get_whitelisted_items(items, wl)
    assert len(out) == 2
    assert all(it["title_key"] in ("lookism", "tower") for it in out)
