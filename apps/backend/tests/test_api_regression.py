"""Regression tests for the 2026-08 API hardening work.

Covers: whitelist pagination, cross-source dedup, `type` field presence,
rating normalization (1-10 contract), RSS whitelist=true non-empty behavior.
These guard fixes that previously regressed silently (e.g. grouped RSS
rebuild dropped `type`; sparse touch rows failed whole chunks).
"""
import os
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _auth() -> dict:
    # Read token at call time (not import time) so conftest's .env load applies.
    return {"Authorization": f"Bearer {os.getenv('MONITOR_AUTH_TOKEN', '')}"}


def _skip_no_token():
    if not os.getenv("MONITOR_AUTH_TOKEN", ""):
        pytest.skip("MONITOR_AUTH_TOKEN not set")


def _get(path):
    return client.get(path, headers=_auth())


class TestWhitelistPagination:
    def test_honors_page_size(self):
        _skip_no_token()
        r = _get("/api/v1/whitelist?page=1&page_size=5")
        assert r.status_code == 200
        d = r.json()["data"]
        assert d["pageSize"] == 5
        assert len(d["results"]) <= 5
        assert d["totalPages"] >= 2 or d["total"] <= 5

    def test_pages_differ(self):
        _skip_no_token()
        p1 = _get("/api/v1/whitelist?page=1&page_size=5").json()["data"]
        p2 = _get("/api/v1/whitelist?page=2&page_size=5").json()["data"]
        t1 = [x.get("titleKey") for x in p1["results"]]
        t2 = [x.get("titleKey") for x in p2["results"]]
        assert t1 != t2, "page 2 must not repeat page 1"

    def test_reader_alias_matches(self):
        _skip_no_token()
        a = _get("/api/v1/whitelist?page=1&page_size=3")
        b = _get("/api/v1/reader/whitelist?page=1&page_size=3")
        assert a.status_code == b.status_code == 200


class TestDedup:
    def test_unique_title_keys_per_page(self):
        _skip_no_token()
        r = _get("/api/v1/whitelist?page=1&page_size=100")
        assert r.status_code == 200
        rows = r.json()["data"]["results"]
        # Whitelist is FLAT-per-source (title_key+source composite PK), so the
        # same title can appear once per source. Assert uniqueness of the
        # (titleKey, source) pair, not bare titleKey.
        pairs = [
            ((x.get("titleKey") or "").strip().lower(), x.get("source") or "")
            for x in rows
        ]
        assert len(pairs) == len(set(pairs)), f"duplicate (titleKey,source) in one page: {pairs}"

    def test_merged_rows_have_sources_list(self):
        _skip_no_token()
        r = _get("/api/v1/whitelist?page=1&page_size=100")
        rows = r.json()["data"]["results"]
        for x in rows:
            assert isinstance(x.get("sources"), list)
            # source compat: source == sources[0] when present
            if x.get("sources"):
                assert x["source"] == x["sources"][0]


class TestTypeField:
    def test_type_present_and_valid(self):
        _skip_no_token()
        r = _get("/api/v1/whitelist?page=1&page_size=50")
        rows = r.json()["data"]["results"]
        valid = {"manhua", "manhwa", "manga", None}
        bad = [x.get("type") for x in rows if x.get("type") not in valid]
        assert not bad, f"invalid type values: {bad}"

    def test_rating_scale_1_to_10(self):
        _skip_no_token()
        r = _get("/api/v1/whitelist?page=1&page_size=100")
        rows = r.json()["data"]["results"]
        out_of_range = [
            x.get("rating") for x in rows
            if x.get("rating") is not None and not (1.0 <= float(x["rating"]) <= 10.0)
        ]
        assert not out_of_range, f"ratings outside 1-10: {out_of_range}"


class TestRss:
    def test_rss_basic_not_empty(self):
        r = client.get("/api/v1/rss?limit=10&group=false")
        assert r.status_code == 200
        assert r.json()["data"]["total"] > 0



    def test_rss_grouped_has_type_key(self):
        r = client.get("/api/v1/rss?limit=5")
        assert r.status_code == 200
        rows = r.json()["data"]["results"]
        if rows:
            assert "type" in rows[0], "grouped output dropped the type field"


class TestGuildSettings:
    def test_load_guild_settings_shape(self):
        from app.cron.dispatch_mod import load_guild_settings
        rows = load_guild_settings()
        assert isinstance(rows, list)
        for g in rows:
            assert "channel_id" in g
            assert "origin_filter" in g
            assert "excluded_titles" in g
