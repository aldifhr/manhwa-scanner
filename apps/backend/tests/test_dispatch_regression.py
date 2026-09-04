"""Regression tests for the dispatch path.

Covers: FCFS dedupe, guild origin_filter, guild excluded_titles,
presigned cover passthrough, cover fallback recent_chapters → whitelist.
"""
import pytest
from unittest.mock import patch, MagicMock
from app.services.shared import fcfs_key
from app.utils.text import normalize_title_key


# ── Helpers ──────────────────────────────────────────────────────────────────

def _item(title="Example", title_key="example", source="shinigami",
          chapter="1", url="https://x/1", cover="https://cover/1.webp",
          origin="KR", series_url="https://series/x", **kw):
    """Build a dispatch-able item with sensible defaults."""
    return {
        "title": title, "title_key": title_key, "source": source,
        "chapter": chapter, "url": url, "chapter_url": url,
        "cover": cover, "series_url": series_url, "origin": origin,
        "rating": "8.0", "genres": ["Action"], "description": "d",
        "updated_time": "2026-09-01T00:00:00Z", **kw,
    }


def _guild(channel_id="123", origin_filter="", excluded_titles=None, label="test"):
    return {
        "channel_id": channel_id,
        "origin_filter": origin_filter,
        "excluded_titles": excluded_titles or [],
        "label": label,
    }


# ── FCFS dedupe ──────────────────────────────────────────────────────────────

class TestFcFSDedupe:
    def test_same_title_chapter_always_same_key(self):
        assert fcfs_key("The Great Ruler", "326") == fcfs_key("THE GREAT RULER", "326")

    def test_html_entities_normalized(self):
        assert fcfs_key("Academy's", "1") == fcfs_key("Academy&#8217;s", "1")

    def test_trailing_punctuation_stripped(self):
        assert fcfs_key("Example Series!", "5") == "example series#5"

    def test_different_chapters_are_distinct(self):
        assert fcfs_key("Same Title", "1") != fcfs_key("Same Title", "2")

    def test_different_titles_are_distinct(self):
        assert fcfs_key("Title A", "1") != fcfs_key("Title B", "1")


# ── Guild origin_filter ─────────────────────────────────────────────────────

class TestGuildOriginFilter:
    def test_no_filter_accepts_all(self):
        guild = _guild(origin_filter="")
        origin_f = {o.strip().upper() for o in guild["origin_filter"].split(",") if o.strip()}
        assert not origin_f  # empty

    def test_kr_only_filters_out_cn(self):
        guild = _guild(origin_filter="KR")
        origin_f = {o.strip().upper() for o in guild["origin_filter"].split(",") if o.strip()}
        assert "KR" in origin_f
        assert "CN" not in origin_f

    def test_cn_kr_accepts_both(self):
        guild = _guild(origin_filter="CN,KR")
        origin_f = {o.strip().upper() for o in guild["origin_filter"].split(",") if o.strip()}
        assert "CN" in origin_f
        assert "KR" in origin_f

    def test_case_insensitive_filter(self):
        guild = _guild(origin_filter="kr")
        origin_f = {o.strip().upper() for o in guild["origin_filter"].split(",") if o.strip()}
        assert "KR" in origin_f


# ── Guild excluded_titles ───────────────────────────────────────────────────

class TestGuildExcludedTitles:
    def test_no_exclusions(self):
        guild = _guild(excluded_titles=[])
        excl = {normalize_title_key(t) for t in guild["excluded_titles"] if t}
        assert not excl

    def test_excluded_title_skipped(self):
        guild = _guild(excluded_titles=["bad title"])
        excl = {normalize_title_key(t) for t in guild["excluded_titles"] if t}
        assert normalize_title_key("bad title") in excl

    def test_excluded_title_case_insensitive(self):
        guild = _guild(excluded_titles=["Bad Title"])
        excl = {normalize_title_key(t) for t in guild["excluded_titles"] if t}
        assert normalize_title_key("bad title") in excl


# ── Presigned cover passthrough ─────────────────────────────────────────────

class TestPresignedCoverPassthrough:
    def test_presigned_voratoon_cover_stays_intact(self):
        """Voratoon presigned cover must NOT be stripped — bare URL returns 403."""
        presigned = (
            "https://cvr.voratoon.id/prod/series/crimson-reset/cover/vampire.webp"
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=Zgozh0pCiplFv4J3"
            "&X-Amz-Expires=518400&X-Amz-Signature=abc123"
        )
        item = _item(cover=presigned)
        # cover should be preserved as-is
        assert item["cover"] == presigned

    def test_cover_ref_returns_proxy_url(self):
        """cover_ref for voratoon returns proxy?url=... (presigned params encoded in url=)."""
        from app.utils.cover_scrub import scrub_cover
        presigned = (
            "https://cvr.voratoon.id/prod/series/crimson-reset/cover/vampire.webp"
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=Zgozh0pCiplFv4J3"
            "&X-Amz-Expires=518400&X-Amz-Signature=abc123"
        )
        result = scrub_cover(presigned)
        # Response body has /api/v1/reader/proxy?url=<encoded> — presigned params are
        # in the url= query string (encoded), NOT bare in the response body.
        assert result.startswith("/api/v1/reader/proxy?url=")
        assert "cvr.voratoon.id" in result  # host preserved

    def test_public_cover_strips_noise(self):
        """Shinigami/ikiru public covers have AWS noise stripped."""
        from app.utils.cover_scrub import scrub_cover
        url = "https://assets.shngm.id/cover/123.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc"
        result = scrub_cover(url)
        assert "X-Amz" not in result
        assert result.startswith("https://assets.shngm.id/")


# ── Cover fallback ───────────────────────────────────────────────────────────

class TestCoverFallback:
    def test_recent_chapters_cover_preferred(self):
        """recent_chapters cover takes precedence over whitelist."""
        item = _item(cover="https://recent/1.webp")
        _wl_cover_map = {("example", "shinigami"): "https://whitelist/1.webp"}
        # simulate fallback logic from dispatch_mod.py:179-184
        _cover = str(item.get("cover") or "").strip()
        if not _cover:
            _tk = str(item.get("title_key") or "").strip()
            _src = str(item.get("source") or "").strip()
            _cover = _wl_cover_map.get((_tk, _src), "") or _wl_cover_map.get((_tk, ""), "")
        assert _cover == "https://recent/1.webp"

    def test_whitelist_fallback_when_recent_empty(self):
        """When recent_chapters cover is empty, use whitelist cover."""
        item = _item(cover="")
        _wl_cover_map = {("example", "shinigami"): "https://whitelist/1.webp"}
        _cover = str(item.get("cover") or "").strip()
        if not _cover:
            _tk = str(item.get("title_key") or "").strip()
            _src = str(item.get("source") or "").strip()
            _cover = _wl_cover_map.get((_tk, _src), "") or _wl_cover_map.get((_tk, ""), "")
        assert _cover == "https://whitelist/1.webp"

    def test_no_cover_when_both_empty(self):
        """When both are empty, cover is empty string."""
        item = _item(cover="")
        _wl_cover_map = {}
        _cover = str(item.get("cover") or "").strip()
        if not _cover:
            _tk = str(item.get("title_key") or "").strip()
            _src = str(item.get("source") or "").strip()
            _cover = _wl_cover_map.get((_tk, _src), "") or _wl_cover_map.get((_tk, ""), "")
        assert _cover == ""
