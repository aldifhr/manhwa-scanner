"""Regression tests for today's perf fixes.

Covers: .first() LIMIT 1, fail-closed dedup, whitelist cache invalidation,
source health status normalization.
"""
import pytest
from unittest.mock import patch, MagicMock


class TestDbAdapterFirst:
    """db_adapter._Query.first() should produce LIMIT 1 SQL."""

    def test_first_modifier(self):
        from app.db_adapter import _Query
        sql, params = _Query("wc", "select").select("id").eq("k", "v").first().compile()
        assert "LIMIT 1" in sql
        assert "ORDER BY" not in sql

    def test_single_no_limit(self):
        from app.db_adapter import _Query
        sql, params = _Query("wc", "select").select("id").eq("k", "v").single().compile()
        assert "LIMIT 2" in sql


class TestRecentChaptersDedup:
    """_load_existing_rc should fail-closed (raise) on DB error."""

    def test_load_existing_rc_raises_on_error(self):
        from app.storage.recent_chapters import _load_existing_rc
        with patch("app.storage.recent_chapters.get_supabase") as mock_sb:
            mock_sb.return_value.table.return_value.select.return_value.in_.return_value.gte.return_value.execute.side_effect = Exception("DB down")
            with pytest.raises(Exception, match="DB down"):
                _load_existing_rc([{"title_key": "solo-leveling"}])

    def test_composite_key(self):
        from app.storage.recent_chapters import _composite_key
        assert _composite_key({"title_key": "a", "source": "b", "chapter_num": 5}) == ("a", "b", "5")
        assert _composite_key({"title_key": "", "source": "b", "chapter_num": 5}) is None

    def test_norm_chapter_num(self):
        from app.storage.recent_chapters import _norm_chapter_num
        assert _norm_chapter_num(46) == "46"
        assert _norm_chapter_num(46.0) == "46"
        assert _norm_chapter_num("46.5") == "46.5"
        assert _norm_chapter_num(None) is None


class TestWhitelistCache:
    """Whitelist origin cache should invalidate on add."""

    def test_invalidate_chain(self):
        from app.storage import recent_chapters as rc
        rc._wl_origins = {("test", "ikiru"): "KR"}
        rc._WL_ORIGIN_TS = 9999999999
        rc.invalidate_whitelist_origin_cache()
        assert rc._wl_origins == {}
        assert rc._WL_ORIGIN_TS == 0.0


class TestSourceHealthStatus:
    """Status should be uppercased to satisfy check constraint."""

    def test_status_normalization(self):
        from app.storage.health import save_source_health_map
        hm = {"ikiru": {"status": "healthy", "consecutive_failures": 0}}
        with patch("app.storage.health.get_supabase") as mock_sb:
            save_source_health_map(hm)
            call_args = mock_sb.return_value.table.return_value.upsert.call_args
            rows = call_args[0][0]
            assert rows[0]["status"] == "HEALTHY"

    def test_status_cooldown_skipped(self):
        from app.storage.health import save_source_health_map
        hm = {"ikiru": {"status": "disabled", "last_error": "cooldown"}}
        with patch("app.storage.health.get_supabase") as mock_sb:
            save_source_health_map(hm)
            mock_sb.return_value.table.return_value.upsert.assert_not_called()
