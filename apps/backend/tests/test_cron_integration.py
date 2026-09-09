"""Integration tests for CRON pipeline: scheduler intervals, pipeline end-to-end, worker blpop."""
import json
import time
from unittest.mock import MagicMock, patch, call

import pytest


# ── Fixtures ──────────────────────────────────────────────────────────

@pytest.fixture
def mock_redis():
    """Shared mock Redis client."""
    r = MagicMock()
    r.lrange.return_value = []
    r.rpush.return_value = 1
    r.llen.return_value = 0
    r.delete.return_value = 1
    r.blpop.return_value = None
    r.ping.return_value = True
    r.get.return_value = None
    r.set.return_value = True
    return r


@pytest.fixture
def mock_supabase():
    """Mock Supabase client."""
    sb = MagicMock()
    res = MagicMock()
    res.data = []
    sb.table.return_value.select.return_value.execute.return_value = res
    sb.table.return_value.select.return_value.eq.return_value.execute.return_value = res
    sb.table.return_value.select.return_value.in_.return_value.execute.return_value = res
    return sb


# ── 1. Scheduler enqueue intervals ────────────────────────────────────

class TestSchedulerIntervals:
    """Verify scheduler.enqueue is called with correct intervals."""

    def test_dispatch_interval_constant(self):
        """Update job interval is 120s."""
        from app.tasks import scheduler
        assert scheduler._DISPATCH_INTERVAL_S == 120

    def test_source_interval_constant(self):
        """RSS fetch interval is 600s."""
        from app.tasks import scheduler
        assert scheduler._SOURCE_INTERVAL_S == 600

    def test_enrich_interval_constant(self):
        """Enrich interval is 3600s."""
        from app.tasks import scheduler
        assert scheduler._ENRICH_INTERVAL_S == 3600

    def test_enrich_missing_interval_constant(self):
        """Enrich-missing interval is 3600s."""
        from app.tasks import scheduler
        assert scheduler._ENRICH_MISSING_INTERVAL_S == 3600

    def test_enrich_refresh_interval_constant(self):
        """Enrich-refresh interval is 604800s (7 days)."""
        from app.tasks import scheduler
        assert scheduler._ENRICH_REFRESH_INTERVAL_S == 604800

    def test_voratoon_cover_interval_constant(self):
        """Voratoon cover interval is 86400s (1 day)."""
        from app.tasks import scheduler
        assert scheduler._VORATOON_COVER_INTERVAL_S == 86400

    def test_vseries_refresh_interval_constant(self):
        """v_series refresh interval is 3600s."""
        from app.tasks import scheduler
        assert scheduler._VSERIES_REFRESH_INTERVAL_S == 3600

    def test_initial_enqueue_on_start(self, mock_redis):
        """Scheduler enqueues rss-fetch for all sources + enrich on start."""
        with patch("app.tasks.queue._get_redis", return_value=mock_redis), \
             patch("app.tasks.scheduler._stop") as mock_stop:
            mock_stop.is_set.return_value = True
            mock_stop.wait.return_value = True  # break loop immediately

            from app.tasks.scheduler import _scheduler_loop
            _scheduler_loop()

        # Should have enqueued: rss-fetch:ikiru, rss-fetch:shinigami, rss-fetch:voratoon, enrich
        calls = mock_redis.rpush.call_args_list
        enqueued = [json.loads(c[0][1]) for c in calls]
        actions = [e.get("action") for e in enqueued]

        assert any(a.startswith("rss-fetch") for a in actions)
        assert "enrich" in actions

    def test_initial_rss_fetch_includes_all_sources(self, mock_redis):
        """All 3 sources get rss-fetch enqueued on start."""
        with patch("app.tasks.queue._get_redis", return_value=mock_redis), \
             patch("app.tasks.scheduler._stop") as mock_stop:
            mock_stop.is_set.return_value = True
            mock_stop.wait.return_value = True

            from app.tasks.scheduler import _scheduler_loop
            _scheduler_loop()

        calls = mock_redis.rpush.call_args_list
        rss_calls = [json.loads(c[0][1]) for c in calls if json.loads(c[0][1]).get("action", "").startswith("rss-fetch")]
        sources = {c.get("source") for c in rss_calls}

        assert sources == {"ikiru", "shinigami", "voratoon"}


# ── 2. Pipeline end-to-end ───────────────────────────────────────────

class TestPipelineEndToEnd:
    """Verify pipeline.run_pipeline processes items end-to-end with mocked scrapers."""

    def test_rss_fetch_mode_scrape_and_persist(self):
        """rss-fetch mode: collect → enrich → batch_insert (no dispatch)."""
        mock_items = [
            {"title": "Series A", "chapter": "1", "url": "https://x/a1", "series_url": "https://x/a", "source": "ikiru"},
            {"title": "Series B", "chapter": "2", "url": "https://x/b2", "series_url": "https://x/b", "source": "shinigami"},
        ]
        health_map = {"ikiru": {"status": "healthy"}, "shinigami": {"status": "healthy"}}

        with patch("app.cron.pipeline.collect.collect_recent_chapters", return_value=(mock_items, health_map)), \
             patch("app.cron.pipeline.enrich_mod.enrich", return_value=mock_items), \
             patch("app.cron.pipeline.recent_chapters.batch_insert_recent_chapters") as mock_insert, \
             patch("app.cron.pipeline.health_store.save_source_health_map"), \
             patch("app.cron.pipeline.recent_chapters.prune_older_than"), \
             patch("app.cron.pipeline.recent_chapters.prune_dispatch_history_older_than"), \
             patch("app.cron.pipeline.health.write_cron_status"), \
             patch("app.cron.pipeline.load_whitelist_cached", return_value=[]):

            from app.cron.pipeline import run_pipeline
            stats = run_pipeline(action="rss-fetch:ikiru", do_dispatch=False)

        assert stats["fetched"] == 2
        assert stats["dispatched"] is False
        mock_insert.assert_called_once_with(mock_items)

    def test_dispatch_mode_full_flow(self):
        """update mode: claim → enrich → filter_whitelisted → dispatch."""
        mock_items = [
            {"title": "Whitelisted Series", "chapter": "10", "url": "https://x/ws10", "series_url": "https://x/ws", "source": "ikiru", "title_key": "whitelisted_series"},
        ]
        mock_whitelist = [{"title_key": "whitelisted_series", "title": "Whitelisted Series"}]
        mock_channels = ["chan_123"]

        with patch("app.cron.pipeline._probe_source_health", return_value={}), \
             patch("app.cron.pipeline.load_whitelist_cached", return_value=mock_whitelist), \
             patch("app.services.dispatch_service.dispatch_service.claim_for_dispatch", return_value=mock_items), \
             patch("app.cron.pipeline.enrich_mod.enrich", return_value=mock_items), \
             patch("app.cron.pipeline.collect.filter_whitelisted", return_value=mock_items), \
             patch("app.cron.pipeline.dispatch_mod._load_channels", return_value=mock_channels), \
             patch("app.cron.pipeline.dispatch_mod.dispatch", return_value=1) as mock_dispatch, \
             patch("app.cron.pipeline.health_store.save_source_health_map"), \
             patch("app.cron.pipeline.recent_chapters.prune_older_than"), \
             patch("app.cron.pipeline.recent_chapters.prune_dispatch_history_older_than"), \
             patch("app.cron.pipeline.health.write_cron_status"), \
             patch("app.storage.dispatch.unclaim_stale"):

            from app.cron.pipeline import run_pipeline
            stats = run_pipeline(action="update", do_dispatch=True)

        assert stats["sent"] == 1
        assert stats["matched"] == 1
        assert stats["dispatched"] is True
        mock_dispatch.assert_called_once()

    def test_dispatch_mode_dry_run_no_discord(self):
        """dry_run=True computes dispatch but doesn't send to Discord."""
        mock_items = [
            {"title": "Test", "chapter": "5", "url": "https://x/t5", "series_url": "https://x/t", "source": "ikiru", "title_key": "test"},
        ]
        mock_whitelist = [{"title_key": "test", "title": "Test"}]

        with patch("app.cron.pipeline._probe_source_health", return_value={}), \
             patch("app.cron.pipeline.load_whitelist_cached", return_value=mock_whitelist), \
             patch("app.services.dispatch_service.dispatch_service.claim_for_dispatch", return_value=mock_items), \
             patch("app.cron.pipeline.enrich_mod.enrich", return_value=mock_items), \
             patch("app.cron.pipeline.collect.filter_whitelisted", return_value=mock_items), \
             patch("app.cron.pipeline.dispatch_mod._load_channels", return_value=["chan"]), \
             patch("app.cron.pipeline.dispatch_mod.dispatch") as mock_dispatch, \
             patch("app.cron.pipeline.health_store.save_source_health_map"), \
             patch("app.cron.pipeline.recent_chapters.prune_older_than"), \
             patch("app.cron.pipeline.recent_chapters.prune_dispatch_history_older_than"), \
             patch("app.cron.pipeline.health.write_cron_status"):

            from app.cron.pipeline import run_pipeline
            stats = run_pipeline(action="update", do_dispatch=True, dry_run=True)

        # dispatch should be called with dry_run=True
        mock_dispatch.assert_called_once()
        call_kwargs = mock_dispatch.call_args[1]
        assert call_kwargs.get("dry_run") is True

    def test_pipeline_handles_empty_items(self):
        """Pipeline handles empty scrape results gracefully."""
        with patch("app.cron.pipeline.collect.collect_recent_chapters", return_value=([], {})), \
             patch("app.cron.pipeline.enrich_mod.enrich", return_value=[]), \
             patch("app.cron.pipeline.recent_chapters.batch_insert_recent_chapters") as mock_insert, \
             patch("app.cron.pipeline.health_store.save_source_health_map"), \
             patch("app.cron.pipeline.recent_chapters.prune_older_than"), \
             patch("app.cron.pipeline.recent_chapters.prune_dispatch_history_older_than"), \
             patch("app.cron.pipeline.health.write_cron_status"):

            from app.cron.pipeline import run_pipeline
            stats = run_pipeline(action="rss-fetch", do_dispatch=False)

        assert stats["fetched"] == 0
        mock_insert.assert_called_once_with([])

    def test_pipeline_error_returns_error_stats(self):
        """Pipeline returns error stats on exception."""
        with patch("app.cron.pipeline._probe_source_health", side_effect=Exception("DB down")), \
             patch("app.cron.pipeline.recent_chapters.prune_older_than"), \
             patch("app.cron.pipeline.recent_chapters.prune_dispatch_history_older_than"), \
             patch("app.cron.pipeline.health.write_cron_status"):

            from app.cron.pipeline import run_pipeline
            stats = run_pipeline(action="update", do_dispatch=True)

        assert stats["failed"] == 1
        assert "error" in stats


# ── 3. Worker blpop processes queue items ────────────────────────────

class TestWorkerBlpop:
    """Verify worker blpop processes queue items."""

    def test_blpop_reads_from_cron_queue(self, mock_redis):
        """Worker blpop reads from CRON_QUEUE_KEY."""
        mock_redis.blpop.return_value = ("beag:cron", json.dumps({"action": "update"}))

        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.tasks.lifecycle._stop") as mock_stop, \
             patch("app.tasks.lifecycle.run_cron_inline"), \
             patch("app.tasks.lifecycle.logger"):
            # First check: False (enter loop), then after blpop: True (break)
            mock_stop.is_set.side_effect = [False, True]

            from app.tasks.lifecycle import run_cron_worker
            run_cron_worker()

        mock_redis.blpop.assert_called_once()
        args = mock_redis.blpop.call_args
        assert args[0][0] == "beag:cron"  # first positional arg
        assert args[1].get("timeout") == 5  # timeout kwarg

    def test_blpop_processes_update_action(self, mock_redis):
        """Worker processes update action via run_cron_inline."""
        mock_redis.blpop.return_value = ("beag:cron", json.dumps({"action": "update"}))

        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.tasks.lifecycle._stop") as mock_stop, \
             patch("app.tasks.lifecycle.run_cron_inline") as mock_inline:
            mock_stop.is_set.side_effect = [False, True]

            from app.tasks.lifecycle import run_cron_worker
            run_cron_worker()

        mock_inline.assert_called_once_with("update")

    def test_blpop_processes_rss_fetch_action(self, mock_redis):
        """Worker processes rss-fetch:ikiru action."""
        payload = {"action": "rss-fetch:ikiru"}
        mock_redis.blpop.return_value = ("beag:cron", json.dumps(payload))

        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.tasks.lifecycle._stop") as mock_stop, \
             patch("app.tasks.lifecycle.run_cron_inline") as mock_inline:
            mock_stop.is_set.side_effect = [False, True]

            from app.tasks.lifecycle import run_cron_worker
            run_cron_worker()

        mock_inline.assert_called_once_with("rss-fetch:ikiru")

    def test_blpop_skips_none_result(self, mock_redis):
        """Worker continues loop when blpop returns None (timeout)."""
        mock_redis.blpop.return_value = None

        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.tasks.lifecycle._stop") as mock_stop, \
             patch("app.tasks.lifecycle.run_cron_inline") as mock_inline:
            # First iteration: blpop returns None, is_set False
            # Second iteration: is_set True (break)
            mock_stop.is_set.side_effect = [False, True]

            from app.tasks.lifecycle import run_cron_worker
            run_cron_worker()

        mock_inline.assert_not_called()

    def test_blpop_skips_bad_json(self, mock_redis):
        """Worker drops malformed JSON payloads."""
        mock_redis.blpop.return_value = ("beag:cron", "not valid json{")

        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.tasks.lifecycle._stop") as mock_stop, \
             patch("app.tasks.lifecycle.run_cron_inline") as mock_inline, \
             patch("app.tasks.lifecycle.logger"):
            mock_stop.is_set.side_effect = [False, True]

            from app.tasks.lifecycle import run_cron_worker
            run_cron_worker()

        mock_inline.assert_not_called()

    def test_blpop_handles_redis_error(self, mock_redis):
        """Worker retries on Redis connection error."""
        mock_redis.blpop.side_effect = Exception("Connection refused")

        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.tasks.lifecycle._stop") as mock_stop, \
             patch("app.tasks.lifecycle.logger"):
            mock_stop.is_set.side_effect = [False, True]
            mock_stop.wait.return_value = None

            from app.tasks.lifecycle import run_cron_worker
            run_cron_worker()

        # Should have waited and retried
        mock_stop.wait.assert_called()


# ── 4. run_cron_inline integration ───────────────────────────────────

class TestRunCronInline:
    """Verify run_cron_inline dispatches to pipeline correctly."""

    def test_inline_calls_run_pipeline_for_update(self, mock_redis):
        """run_cron_inline calls run_pipeline for update action."""
        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.cron.pipeline.run_pipeline") as mock_pipeline:
            from app.tasks.lifecycle import run_cron_inline
            run_cron_inline("update")

        mock_pipeline.assert_called_once_with(action="update", do_dispatch=True)

    def test_inline_calls_run_pipeline_for_rss_fetch(self, mock_redis):
        """run_cron_inline calls run_pipeline with do_dispatch=False for rss-fetch."""
        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.cron.pipeline.run_pipeline") as mock_pipeline:
            from app.tasks.lifecycle import run_cron_inline
            run_cron_inline("rss-fetch:ikiru")

        mock_pipeline.assert_called_once_with(action="rss-fetch:ikiru", do_dispatch=False)

    def test_inline_retries_on_failure(self, mock_redis):
        """run_cron_inline retries up to 3 times on failure."""
        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.cron.pipeline.run_pipeline", side_effect=Exception("fail")) as mock_pipeline, \
             patch("app.tasks.lifecycle._stop.wait"), \
             patch("app.tasks.lifecycle.logger"):
            from app.tasks.lifecycle import run_cron_inline
            run_cron_inline("update")

        assert mock_pipeline.call_count == 3

    def test_inline_moves_to_dlq_after_max_retries(self, mock_redis):
        """After 3 failures, job is moved to DLQ."""
        with patch("app.tasks.lifecycle._get_redis", return_value=mock_redis), \
             patch("app.cron.pipeline.run_pipeline", side_effect=Exception("fail")), \
             patch("app.tasks.lifecycle._stop.wait"), \
             patch("app.tasks.lifecycle.logger"):
            from app.tasks.lifecycle import run_cron_inline
            run_cron_inline("update")

        mock_redis.rpush.assert_called()
        dlq_call = mock_redis.rpush.call_args
        assert dlq_call[0][0] == "beag:tasks:dlq"
