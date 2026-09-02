"""Cron dual-pass scrape pipeline (parity with lib/cron/dual-pass-scrape.ts).

Orchestrates: scrape sources -> filter whitelist -> enrich -> dispatch to Discord.

This module uses the new services layer (scraper_service, dispatch_service)
internally. Symbols from legacy modules (collect, enrich, dispatch_mod) are
re-exported for backward compatibility with existing call sites.
"""
from __future__ import annotations

import time

from app.cron import collect, dispatch_mod, enrich as enrich_mod
from app.config import settings
from app.logger import get_logger
from app.storage import health, whitelist as wl_store

logger = get_logger("cron:dual-pass")

# alias used throughout (run_pipeline + callers reference health_store)
health_store = health


# ── Re-exports (call-site compatibility) ──
# collect
_parse_chapter_num = collect._parse_chapter_num
_parse_types = collect._parse_types
collect_recent_chapters = collect.collect_recent_chapters
filter_whitelisted = collect.filter_whitelisted
_ikiru_slug_from_source = collect._ikiru_slug_from_source
collect_whitelisted_shinigami_chapters = collect.collect_whitelisted_shinigami_chapters
collect_whitelisted_ikiru_chapters = collect.collect_whitelisted_ikiru_chapters

# enrich
enrich = enrich_mod.enrich
_split_send_backfill = enrich_mod._split_send_backfill
mark_history_only = enrich_mod.mark_history_only
backfill_dispatch_history = enrich_mod.backfill_dispatch_history

# dispatch_mod
dispatch = dispatch_mod.dispatch
_load_channels = dispatch_mod._load_channels


def run_pipeline(channel_ids: list[str] | None = None, do_dispatch: bool = True, dry_run: bool = False, action: str = "update") -> dict:
    """Full dual-pass run. Returns stats dict.

    do_dispatch=False → scrape + persist only (rss-fetch mode, no Discord send).
    do_dispatch=True  → read from recent_chapters (RSS is the data provider), dispatch whitelisted.

    dry_run=True → when do_dispatch=True, compute the FULL dispatch (match +
    FCFS) but do NOT send to Discord and do NOT write dispatch_history/
    dispatch_claims. Returns accurate `sent`/`matched` counts for what a live
    run WOULD do, without spamming the channel or polluting the DB. The FCFS
    guard still runs against the real dispatch_history, so it predicts skips
    correctly. Ignored when do_dispatch=False (fetch mode never sends anyway).
    """
    start = time.time()
    instance_id = f"be-ag-py-{int(start)}"
    _use_claimed = False  # set True only when the deep-queue claim path is used

    # Prune anything older than the 24h window before this run so backlog
    # never accumulates in recent_chapters (user: "24 jam doang").
    try:
        recent_chapters.prune_older_than(24)
    except Exception as e:
        logger.warn("collect: recent_chapters prune failed", err=str(e)[:160])

    # Parse source from action string (e.g., "rss-fetch:ikiru" → source="ikiru")
    source = None
    if ":" in action:
        action, source = action.split(":", 1)

    logger.info("pipeline start", action=action, source=source or "all", do_dispatch=do_dispatch, instance=instance_id)
    try:
        # ── Per-source health telemetry ──
        _health_map: dict = {}
        if not do_dispatch:
            # Full telemetry from the actual scrape
            items, _health_map = collect_recent_chapters(
                with_whitelisted_ikiru=True,
                with_whitelisted_shinigami=True,
                source=source,
                fetch_meta=True,  # lazy: skips series already in series_meta, bootstraps new ones
            )
            # PERF: persist per-source health (incl. voratoon) so /status shows
            # real telemetry instead of a stale row. collect_recent_chapters
            # builds _hm but never saved it before — voratoon's disabled_until
            # stayed frozen from an old failure, making /status show "cooldown".
            try:
                health_store.save_source_health_map(_health_map)
            except Exception as _he:
                logger.warn("collect health persist failed", err=str(_he)[:160])
            enriched_all = enrich(items, persist_cache=True, skip_api=True)
            recent_chapters.batch_insert_recent_chapters(enriched_all)
        else:
            # Dispatch mode: deep queue claim (FOR UPDATE SKIP LOCKED) — atomic whitelisted claim.
            _health_map = _probe_source_health()
            _use_claimed = False
            try:
                _wl_for_claim = load_whitelist_cached()
                _claimed = recent_chapters.claim_recent_chapters_for_dispatch(whitelist=_wl_for_claim, hours=24, limit=500)
                if _claimed:
                    items = _claimed
                    enriched_all = enrich(items, persist_cache=False)
                    _use_claimed = True
                else:
                    raise ValueError("no claimed rows, fallback")
            except Exception as e:
                logger.debug("claim queue fallback to get_recent_chapters", err=str(e)[:80])
                items = recent_chapters.get_recent_chapters(hours=24)
                enriched_all = enrich(items, persist_cache=False)
                _use_claimed = False
        # Persist health (both modes)
        try:
            health_store.save_source_health_map(_health_map)
        except Exception as e:
            logger.error("save source health failed", exc=e)

        if do_dispatch:
            # Auto-release STUCK claims (created >15m ago but never completed).
            try:
                from datetime import datetime, timezone, timedelta
                from app.storage import dispatch as _ds
                cutoff = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
                _ds.unclaim_stale(cutoff)
            except Exception as e:
                logger.warn("unclaim_stale failed", err=str(e)[:160])
            whitelist = load_whitelist_cached()
            # dispatch ONLY whitelisted items to Discord — if deep queue already claimed+filtered, skip filter
            if _use_claimed:
                to_dispatch = enriched_all
            else:
                to_dispatch = filter_whitelisted(enriched_all, whitelist) if whitelist else []
            channels = channel_ids or _load_channels()
            # When the deep-queue claim path (_use_claimed) was used, the URLs
            # were ALREADY written to dispatch_claims by
            # claim_recent_chapters_for_dispatch() in the same transaction.
            # Calling dispatch() with the default claim guard would re-check
            # dispatch_claims, see its own just-written claims, and skip EVERY
            # item (sent:0) — the bug where cron ran forever with dispatched:true
            # but nothing was sent. force=True here only bypasses the duplicate
            # claim+guard; dispatch() still writes dispatch_history on success
            # so FCFS dedupe across future runs keeps working.
            _dispatch_force = bool(_use_claimed)
            sent = dispatch(to_dispatch, channels, instance_id, dry_run=dry_run, force=_dispatch_force) if to_dispatch else 0
            # Drain the failed-dispatches queue (transient Discord failures)
            # on every dispatch run, so a hiccup doesn't lose notifications.
            retry_stats: dict = {}
            if not dry_run:
                try:
                    from app.storage import dispatch as _ds
                    retry_stats = _ds.retry_failed_dispatches(channels)
                except Exception as e:
                    logger.error("pipeline retry_failed failed", exc=e)
                # Alert admin if failures accumulated above threshold
                try:
                    from app.cron.dispatch_alert import check_and_alert_failed_dispatches
                    check_and_alert_failed_dispatches()
                except Exception as e:
                    logger.warn("dispatch alert check failed", err=str(e)[:120])
                # Chapter gap detection (sent vs scraped) — alert with cooldown
                try:
                    from app.cron.gap_detector import maybe_alert_gaps
                    maybe_alert_gaps()
                except Exception as e:
                    logger.warn("gap detector failed", err=str(e)[:120])
        else:
            sent = 0
            retry_stats = {}

        duration = round(time.time() - start, 1)
        stats = {
            "sent": sent,
            "skipped": 0,
            "failed": 0,
            "guilds": 1,
            "duration": duration,
            "fetched": len(items),
            "matched": len(to_dispatch) if do_dispatch else 0,
            "dispatched": do_dispatch,
            "retry_failed": retry_stats,
        }
        logger.info("Cron completed", **stats)
        health.write_cron_status("ok", chapters_sent=sent, matched=stats.get("matched", 0), duration=duration)

        # Enrich whitelist entries with metadata from source APIs
        # (cover, rating, genres, description). Runs every dispatch.
        try:
            from app.cron.enrich_whitelist import enrich_all_whitelist
            _enriched = enrich_all_whitelist()
            if _enriched:
                logger.info("whitelist enrichment done", updated=_enriched)
        except Exception as _ee:
            logger.warn("whitelist enrichment failed", err=str(_ee)[:120])

        # Materialized dashboard snapshot: compute once, persist 1 row.
        try:
            from app.api.dashboard.stats import build_snapshot_sync
            _snap = build_snapshot_sync()
            health.write_dashboard_snapshot(_snap)
        except Exception as _se:
            logger.error("cron snapshot persist failed", exc=_se)

        # Retention prune: cron_run_status is an operational log — keep only 2 days
        try:
            from app.db import get_supabase as _gsb_ret
            from datetime import datetime as _dt, timezone as _tz, timedelta as _td
            _gsb_ret().table("cron_run_status").delete().lt(
                "created_at", (_dt.now(_tz.utc) - _td(days=2)).isoformat()
            ).execute()
        except Exception as _re:
            logger.warn("cron retention prune failed", err=str(_re)[:160])

        return stats
    except Exception as e:
        logger.error("pipeline error", exc=e)
        health.write_cron_status("error", duration=round(time.time() - start, 1))
        return {"sent": 0, "skipped": 0, "failed": 1, "error": "internal error", "dispatched": do_dispatch}


# Imports kept at bottom to avoid circular import at module load:
# pipeline imports collect/enrich/dispatch_mod, which don't import pipeline.
from app.storage import recent_chapters  # noqa: E402


# Health-probe cache (PERF-01 #1): probing is on the dispatch critical path.
# Two serial HTTP probes with 15s timeouts = up to 30s stall when upstream is
# slow. Cache the result for a short window so back-to-back cron runs reuse it
# instead of re-probing every time.
_HEALTH_PROBE_CACHE: dict = {}
_HEALTH_PROBE_CACHE_TTL = 120.0  # seconds

# Whitelist cache (PERF follow-up): load_whitelist() is a DB read run on every
# dispatch. Cache it for a short window so consecutive cron runs don't each hit
# Supabase. The enrich throttle (PERF-01) already stops upstream re-scrapes;
# this stops the redundant DB re-read of the whitelist itself.
_WHITELIST_CACHE: dict = {"data": None, "ts": 0.0}
_WHITELIST_CACHE_TTL = 60.0  # seconds


def load_whitelist_cached() -> list[dict]:
    import time as _t
    if _WHITELIST_CACHE["data"] is not None and (_t.time() - _WHITELIST_CACHE["ts"]) < _WHITELIST_CACHE_TTL:
        return _WHITELIST_CACHE["data"]
    _wl = wl_store.load_whitelist()
    _WHITELIST_CACHE["data"] = _wl
    _WHITELIST_CACHE["ts"] = _t.time()
    return _wl


def _probe_source_health(force: bool = False) -> dict:
    """Lightweight per-source health probe for dispatch-mode cron runs.

    Results are cached for _HEALTH_PROBE_CACHE_TTL seconds so consecutive
    cron runs don't each pay up to 2×15s in serial probes. Probes run
    concurrently (ThreadPoolExecutor) so a single slow source can't block
    the other — worst case is one timeout, not two stacked.
    """
    import time as _t
    from datetime import datetime, timezone
    from concurrent.futures import ThreadPoolExecutor
    from app.config import settings as _s

    _now = datetime.now(timezone.utc).isoformat()

    # Serve from cache if fresh and not forced.
    if not force:
        _cached = _HEALTH_PROBE_CACHE.get("_map")
        _ts = _HEALTH_PROBE_CACHE.get("_ts", 0)
        if _cached is not None and (_t.time() - _ts) < _HEALTH_PROBE_CACHE_TTL:
            return _cached

    from curl_cffi import requests as cffi_req

    probes = {
        "ikiru": str(_s.IKIRU_BASE_URL).rstrip("/") + "/",
        "shinigami": str(_s.SECONDARY_SOURCE_URL).rstrip("/") + "/v1/manga/list?page=1&page_size=1&is_update=true&sort=latest",
        "voratoon": f"{settings.VORATOON_API_URL.rstrip(chr(47))}/backend/series?take=1&page=1&sort=latest&sortOrder=desc&includeMeta=true",
    }
    _probe_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }

    try:
        from app.storage import health as _hstore
        prev_map = _hstore.load_source_health_map(list(probes.keys()))
    except Exception:
        prev_map = {}

    def _probe_one(src: str, url: str) -> tuple[str, dict]:
        _prev = prev_map.get(src) or {}
        _prev_consec = int(_prev.get("consecutive_failures") or 0)
        t0 = _t.time()
        last_err = None
        ok = False
        rt = 0
        # Confirm a failure with up to 2 attempts so a single transient
        # timeout (curl_cffi/Cloudflare blip) doesn't flap the source
        # healthy<->degraded every cron tick.
        for _attempt in range(2):
            try:
                r = cffi_req.get(url, headers=_probe_headers, impersonate="chrome", timeout=15)
                rt = int((_t.time() - t0) * 1000)
                if r.status_code < 500:
                    ok = True
                    last_err = None
                    break
                else:
                    last_err = f"HTTP {r.status_code}"
            except Exception as e:
                rt = int((_t.time() - t0) * 1000)
                last_err = str(e)[:300]
        logger.info("[health-probe]", src=src, status="ok" if ok else "fail", rt_ms=rt)
        return src, {
            "status": "healthy" if ok else "degraded",
            "response_time_ms": rt,
            "successes_today": 1 if ok else 0,
            "failures_today": 0 if ok else 1,
            "consecutive_failures": 0 if ok else (_prev_consec + 1),
            "last_success_at": _now if ok else None,
            "last_checked_at": _now,
            "last_error": None if ok else last_err,
        }

    out: dict = {}
    # Concurrent probes: max one timeout (15s), not two stacked (30s).
    with ThreadPoolExecutor(max_workers=len(probes)) as _ex:
        for _src, _res in _ex.map(lambda kv: _probe_one(*kv), probes.items()):
            out[_src] = _res

    try:
        from app.cron.source_alert import alert_source_transitions
        alert_source_transitions(prev_map, out)
    except Exception as _ae:
        logger.warn("source alert dispatch failed", err=str(_ae)[:160])

    _HEALTH_PROBE_CACHE["_map"] = out
    _HEALTH_PROBE_CACHE["_ts"] = _t.time()
    return out