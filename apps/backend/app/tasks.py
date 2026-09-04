"""Durable task queue backed by Redis (replaces the old in-memory queue).

Why Redis: the previous in-process queue lost all pending jobs on process
restart and had no graceful shutdown. Redis lists + BLPOP give us:
  - durability (RDB/AOF persistence survives a PM2 restart)
  - blocking pop (worker sleeps efficiently until work arrives)
  - at-least-once delivery (a job is only removed after it succeeds; on
    crash mid-process the job stays in the queue and is retried)

Jobs are JSON-encoded. We keep a small retry budget; failures go to a
dead-letter list so they don't block the main queue.
"""
from __future__ import annotations

import json
import threading
import time

from app.config import settings
from app.logger import get_logger

logger = get_logger("tasks")

QUEUE_KEY = "beag:tasks"
DLQ_KEY = "beag:tasks:dlq"
CRON_QUEUE_KEY = "beag:cron"
MAX_ATTEMPTS = 3

# Lazily-created Redis client (so import doesn't hard-fail if Redis is down).
_redis = None
_worker_thread: threading.Thread | None = None
_retention_thread: threading.Thread | None = None
_stop = threading.Event()


def _get_redis():
    global _redis
    if _redis is None:
        import redis  # imported lazily so non-worker imports stay cheap
        _redis = redis.Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=5,
            # No socket timeout (None = blocking socket). BLPOP's own
            # `timeout` arg drives the blocking wait; a socket timeout here
            # makes redis-py raise EAGAIN / "Timeout reading from socket"
            # on every idle BLPOP cycle. health-check interval handles
            # real dead connections.
            socket_timeout=None,
            retry_on_timeout=True,
        )
    return _redis


def enqueue_add(title: str, url: str, interaction: dict | None = None) -> None:
    """Push an add-to-whitelist job onto the Redis queue."""
    payload = {
        "kind": "add",
        "title": title,
        "url": url,
        "interaction": interaction or {},
        "attempts": 0,
    }
    try:
        _get_redis().rpush(QUEUE_KEY, json.dumps(payload))
        logger.info("enqueued add task", title=title)
    except Exception as e:
        logger.warn("enqueue failed (redis down), falling back to direct DB write", err=str(e)[:120], title=title)
        # Fallback: direct write so Discord /add still works without Redis (local dev)
        try:
            _do_add(payload)
        except Exception as e2:
            logger.error("direct add fallback failed", exc=e2)
            raise


def _do_add(item: dict) -> None:
    from app.storage import whitelist
    from app.utils.text import normalize_title_key

    title = item["title"]
    url = item["url"]
    tk = normalize_title_key(title)
    res = whitelist.add_whitelist_entries(
        [{"title": title, "title_key": tk, "source": "ikiru", "url": url, "series_url": url}]
    )
    logger.info("add done", title=title, status=res.get("status"))


def _process(payload: dict) -> bool:
    """Process one job. Returns True on success, False on failure."""
    try:
        if payload.get("kind") == "add":
            _do_add(payload)
        else:
            logger.warn("unknown job kind", kind=payload.get("kind"))
        return True
    except Exception as e:
        logger.error("task failed", kind=payload.get("kind"), exc=e)
        return False


def enqueue_cron(action: str) -> None:
    """Push a cron pipeline job onto the Redis cron queue.

    The API process enqueues; a separate ROLE=cron worker pops and runs
    run_pipeline. This keeps the (slow, upstream-heavy) scrape/dispatch off
    the HTTP request path entirely — if the scraper stalls or ikiru hits
    Cloudflare, the RSS API process is unaffected.

    Graceful degradation: if Redis is down we run the pipeline directly in
    the API process (old behaviour) so external cron-triggered crons still work
    without Redis.
    """
    payload = {"action": action}
    try:
        _get_redis().rpush(CRON_QUEUE_KEY, json.dumps(payload))
        logger.info("enqueued cron job", action=action)
    except Exception as e:
        logger.warn("enqueue cron failed (redis down), running inline", err=str(e)[:120], action=action)
        _run_cron_inline(action)


def _run_cron_inline(action: str) -> None:
    # rss-fetch:* actions are SCRAPE jobs (collect new chapters + persist),
    # so they must run in fetch-only mode (do_dispatch=False). Without this,
    # run_pipeline defaults to do_dispatch=True which only reads existing
    # recent_chapters and dispatches — the scraper never runs and the DB
    # stops getting fresh chapters (cron "alive" but feed frozen).
    is_scrape = action.startswith("rss-fetch")
    source = action.split(":", 1)[1] if ":" in action else None
    do_dispatch = not is_scrape

    # enrich / enrich-missing / enrich-resync are metadata-only jobs wired to
    # enrich_resync.py (NOT run_pipeline — pipeline has no route for them).
    if action in ("enrich", "enrich-missing", "enrich-refresh"):
        from app.cron.enrich_resync import enrich_recent_chapters, enrich_stale_series_meta
        if action == "enrich":
            stats = enrich_recent_chapters()
        elif action == "enrich-missing":
            stats = enrich_recent_chapters(limit=100, miss_only=True)
        else:  # enrich-refresh
            stats = enrich_stale_series_meta(stale_days=7, limit=50)
        logger.info("cron enrich done", action=action, stats=stats)
        return

    # voratoon-cover: presigned URL 6d expiry → 24h refresh
    if action == "voratoon-cover":
        from app.cron.enrich_resync import enrich_voratoon_covers
        stats = enrich_voratoon_covers(limit=50)
        logger.info("cron voratoon-cover done", **stats)
        return

    # Retry with exponential backoff: 0s, 2s, 4s, then DLQ
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            from app.cron.pipeline import run_pipeline
            run_pipeline(action=action, do_dispatch=do_dispatch)
            return
        except Exception as e:
            if attempt < max_attempts:
                wait = 2 ** attempt  # 2s, 4s
                logger.warn("cron run failed, retrying", action=action, attempt=attempt, wait=wait, err=str(e)[:120])
                time.sleep(wait)
            else:
                logger.error("cron run failed, moving to DLQ", action=action, attempts=max_attempts, exc=e)
                try:
                    _get_redis().rpush(DLQ_KEY, json.dumps({"action": action, "error": str(e)[:200], "attempts": max_attempts}))
                except Exception:
                    pass
    # Record the last time we ATTEMPTED a scrape for this source, so the
    # /cron monitor shows "scrape is running on schedule" even when the
    # source is quiet (no new chapters -> recent_chapters.updated_time
    # doesn't move, which would otherwise look "stale").
    if is_scrape and source:
        try:
            from datetime import datetime, timezone
            _get_redis().set(
                f"cron:last_scrape:{source}",
                datetime.now(timezone.utc).isoformat(),
                ex=3600,
            )
        except Exception:
            pass


def run_cron_worker() -> None:
    """Blocking worker for the cron queue (ROLE=cron process only).

    Pops cron jobs and runs run_pipeline. At-least-once: a job removed only
    after it succeeds; on crash the job is retried by the scheduler
    (internal scheduler enqueues; this worker executes).
    """
    logger.info("cron worker started")
    while not _stop.is_set():
        try:
            result = _get_redis().blpop(CRON_QUEUE_KEY, timeout=5)
        except Exception as e:
            logger.warn("redis unavailable in cron worker, retrying", err=str(e)[:160])
            _stop.wait(10)
            continue
        if not result:
            continue  # timeout, re-check _stop
        _key, raw = result
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("bad cron payload, dropping", raw=raw[:200])
            continue
        _run_cron_inline(item.get("action", "update"))


# Internal scheduler: fires the 3 source crons (+ enrich) on a fixed interval so
# the pipeline runs autonomously WITHOUT depending on any external trigger.
# The scheduler can still coexist — enqueue_cron() is idempotent per Redis
# list, and the per-action DB advisory lock in run_pipeline de-dupes concurrent
# runs, so a double-fire just becomes a no-op skip.
_SCHED_THREAD: "threading.Thread | None" = None
_RSS_SOURCES = ("ikiru", "shinigami", "voratoon")
_SOURCE_INTERVAL_S = 600          # 10 min per source (RSS fetch takes ~100s)
_DISPATCH_INTERVAL_S = 300        # 5 min Discord dispatch (job takes ~226s)
_ENRICH_INTERVAL_S = 1800        # 30 min (legacy full refresh)
_ENRICH_MISSING_INTERVAL_S = 3600  # 1 hour static-data backfill (miss_only)
_ENRICH_REFRESH_INTERVAL_S = 604800  # 7 days stale check (rating/description drift)
_VORATOON_COVER_INTERVAL_S = 86400  # 24h voratoon presigned cover refresh (6d expiry)


def _scheduler_loop() -> None:
    from datetime import datetime, timezone
    last_enrich = 0.0
    last_enrich_missing = 0.0
    last_enrich_refresh = 0.0
    last_voratoon_cover = 0.0
    last_dispatch = 0.0
    logger.info("cron scheduler started",
                sources=_RSS_SOURCES, source_interval=_SOURCE_INTERVAL_S,
                dispatch_interval=_DISPATCH_INTERVAL_S,
                enrich_interval=_ENRICH_INTERVAL_S,
                enrich_missing_interval=_ENRICH_MISSING_INTERVAL_S,
                enrich_refresh_interval=_ENRICH_REFRESH_INTERVAL_S,
                voratoon_cover_interval=_VORATOON_COVER_INTERVAL_S)
    # Kick off immediately on startup so freshness doesn't wait 10 min.
    _t0 = __import__("time").monotonic()
    for i, src in enumerate(_RSS_SOURCES):
        try:
            enqueue_cron(f"rss-fetch:{src}")
        except Exception as e:
            logger.warn("scheduler enqueue failed", src=src, err=str(e)[:120])
        if i < len(_RSS_SOURCES) - 1:
            _stop.wait(20)  # stagger 20s between sources so ikiru's slow scrape doesn't pile up
    try:
        enqueue_cron("enrich")
        last_enrich = __import__("time").monotonic()
    except Exception:
        pass
    # Then loop: dispatch every 60s, RSS every 300s (staggered), enrich every 900s
    last_source = __import__("time").monotonic()
    while not _stop.is_set():
        if _stop.wait(_DISPATCH_INTERVAL_S):
            break
        _now = __import__("time").monotonic()
        # Discord dispatch every 60s
        if _now - last_dispatch >= _DISPATCH_INTERVAL_S:
            try:
                enqueue_cron("update")
                last_dispatch = _now
            except Exception as e:
                logger.warn("scheduler enqueue dispatch failed", err=str(e)[:120])
        # RSS fetch every 300s
        if _now - last_source >= _SOURCE_INTERVAL_S:
            if not _stop.is_set():
                for src in _RSS_SOURCES:
                    if _stop.is_set():
                        break
                    try:
                        logger.info("scheduler enqueue rss-fetch", source=src)
                        enqueue_cron(f"rss-fetch:{src}")
                    except Exception as e:
                        logger.warn("scheduler enqueue failed", src=src, err=str(e)[:120])
                    _stop.wait(20)
            logger.info("scheduler rss-fetch batch done", sources=_RSS_SOURCES)
            last_source = _now
        # Periodic enrich so metadata stays fresh without external triggers.
        if _now - last_enrich >= _ENRICH_INTERVAL_S:
            try:
                enqueue_cron("enrich")
                last_enrich = _now
            except Exception:
                pass
        # Static-data backfill: only rows missing description/rating/genres (cheap, runs 30m)
        if _now - last_enrich_missing >= _ENRICH_MISSING_INTERVAL_S:
            try:
                enqueue_cron("enrich-missing")
                last_enrich_missing = _now
            except Exception:
                pass
        # Weekly stale check: refresh series_meta older than 7d (rating/desc drift)
        if _now - last_enrich_refresh >= _ENRICH_REFRESH_INTERVAL_S:
            try:
                enqueue_cron("enrich-refresh")
                last_enrich_refresh = _now
            except Exception:
                pass
        # Voratoon cover refresh: private bucket presigned 6d expiry -> 24h
        if _now - last_voratoon_cover >= _VORATOON_COVER_INTERVAL_S:
            try:
                enqueue_cron("voratoon-cover")
                last_voratoon_cover = _now
            except Exception:
                pass

        # Queue depth alert: log + DLQ if queue grows unbounded (> 50)
        try:
            qlen = _get_redis().llen(CRON_QUEUE_KEY)
            if qlen > 50:
                logger.error("cron queue depth exceeded", queue_length=qlen, threshold=50)
        except Exception:
            pass


def start_cron_scheduler() -> None:
    """Start the internal cron scheduler thread (idempotent, ROLE=cron only)."""
    global _SCHED_THREAD
    if _SCHED_THREAD and _SCHED_THREAD.is_alive():
        return
    _SCHED_THREAD = threading.Thread(target=_scheduler_loop, daemon=True, name="cron-scheduler")
    _SCHED_THREAD.start()
    logger.info("cron scheduler thread started")


def get_cron_status() -> dict:
    """Snapshot of the internal cron scheduler for the /cron monitor page.

    Returns scheduler liveness, configured intervals, Redis queue depth, and
    a per-source 'last scrape' timestamp (proxy: newest updated_time in
    recent_chapters for that source). Read-only; safe to call from the API.
    """
    from datetime import datetime, timezone

    status: dict = {
        "scheduler_alive": bool(_SCHED_THREAD and _SCHED_THREAD.is_alive()),
        "source_interval_s": _SOURCE_INTERVAL_S,
        "dispatch_interval_s": _DISPATCH_INTERVAL_S,
        "enrich_interval_s": _ENRICH_INTERVAL_S,
        "enrich_missing_interval_s": _ENRICH_MISSING_INTERVAL_S,
        "enrich_refresh_interval_s": _ENRICH_REFRESH_INTERVAL_S,
        "voratoon_cover_interval_s": _VORATOON_COVER_INTERVAL_S,
        "sources": list(_RSS_SOURCES),
        "now": datetime.now(timezone.utc).isoformat(),
    }
    # Redis queue depth + ping
    try:
        r = _get_redis()
        status["redis_up"] = bool(r.ping())
        status["queue_depth"] = int(r.llen(CRON_QUEUE_KEY))
    except Exception:
        status["redis_up"] = False
        status["queue_depth"] = -1
    # is_processing: scheduler alive AND there is at least one cron job
    # queued/in-flight (rss-fetch/enrich). A non-zero beag:cron depth means
    # cron is actively scraping right now — useful for the /status "Cron
    # Processing" indicator.
    status["is_processing"] = bool(
        status.get("scheduler_alive") and status.get("queue_depth", 0) > 0
    )
    # Per-source last scrape. Prefer the Redis heartbeat written by the
    # worker on every rss-fetch attempt — it reflects "cron ran on schedule"
    # even when a source is quiet (no new chapters -> recent_chapters
    # updated_time doesn't move). Fall back to MAX(updated_time) if the
    # heartbeat is missing (e.g. worker just restarted).
    try:
        r = _get_redis()
    except Exception:
        r = None
    src_status: dict[str, object] = {}
    try:
        from app.db import get_supabase

        sb = get_supabase()
        for src in _RSS_SOURCES:
            last = None
            # Redis heartbeat (cron attempt time)
            if r is not None:
                try:
                    hb = r.get(f"cron:last_scrape:{src}")
                    if hb:
                        last = hb.decode() if isinstance(hb, bytes) else str(hb)
                except Exception:
                    pass
            # Fallback: newest chapter in DB for this source
            if not last:
                try:
                    rows = (
                        sb.table("recent_chapters")
                        .select("updated_time")
                        .eq("source", src)
                        .order("updated_time", desc=True)
                        .limit(1)
                        .execute()
                        .data
                        or []
                    )
                    last = rows[0].get("updated_time") if rows else None
                except Exception:
                    last = None
            # Seconds until the next scheduled scrape tick for this source.
            next_in = None
            if last:
                try:
                    lt = datetime.fromisoformat(last) if isinstance(last, str) else last
                    if lt.tzinfo is None:
                        lt = lt.replace(tzinfo=timezone.utc)
                    elapsed = (datetime.now(timezone.utc) - lt).total_seconds()
                    next_in = max(0, _SOURCE_INTERVAL_S - elapsed)
                except Exception:
                    next_in = None
            src_status[src] = {"last_scrape": last, "next_scrape_in_s": next_in}
    except Exception:
        pass
    status["per_source"] = src_status
    return status


def worker_loop() -> None:
    """Blocking worker: pops jobs, processes them, retries on failure."""
    _fail_streak = 0
    while not _stop.is_set():
        try:
            # BLPOP returns (key, value) or None on timeout.
            result = _get_redis().blpop(QUEUE_KEY, timeout=5)
            _fail_streak = 0
        except Exception as e:
            _fail_streak += 1
            # Redis not available locally (common in dev) — back off longer and warn only first few times to avoid log spam.
            if _fail_streak <= 3:
                logger.warn("redis unavailable, retrying (dev: install Redis or set REDIS_URL)", err=str(e)[:160])
            else:
                logger.debug("redis still unavailable", err=str(e)[:80])
            # exponential backoff 5s -> 30s max
            wait = min(5 * (2 ** min(_fail_streak - 1, 3)), 30)
            _stop.wait(wait)
            continue

        if not result:
            continue  # timeout, loop again (checks _stop)

        _key, raw = result
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("bad payload, dropping", raw=raw[:200])
            continue

        ok = _process(item)
        if not ok:
            item["attempts"] = item.get("attempts", 0) + 1
            if item["attempts"] >= MAX_ATTEMPTS:
                # Dead-letter it so the main queue isn't blocked forever.
                try:
                    _get_redis().rpush(DLQ_KEY, json.dumps(item))
                    logger.error("job moved to DLQ", title=item.get("title"))
                except Exception as e:
                    logger.error("DLQ push failed", exc=e)
            else:
                # Re-enqueue for retry (at-least-once).
                try:
                    _get_redis().rpush(QUEUE_KEY, json.dumps(item))
                except Exception as e:
                    logger.error("re-enqueue failed", exc=e)



# ── Retention / pruning (daily) ──────────────────────────────────────
# dispatch_history grows unbounded; keep 90 days and cap rows per series
# so the DB doesn't balloon in month 3. RSS feed window (24h) is already
# dispatch_history is the FCFS dedup ledger — checked before every Discord
# send so the same chapter is never notified twice. It MUST be retained long
# enough to survive scrape gaps (cron can stall >N days, then catch up and
# realistic scrape gap (cron runs every ~1.6 min, max observed gap 15 min).
# 7 days is a safe buffer for VPS-downtime incidents without unbounded growth
# (~500 rows at current volume). Per-series rows are also capped (below).
_DISPATCH_HISTORY_RETENTION_DAYS = 2
_CHAPTER_CLICKS_RETENTION_DAYS = 90
_CRON_RUN_STATUS_RETENTION_DAYS = 30
_FAILED_DISPATCHES_RETENTION_DAYS = 30
_RETENTION_MAX_PER_SERIES = 500


def _retention_loop() -> None:
    """Hourly check: prune old/overflowing dispatch_history rows + stale claims."""
    while not _stop.is_set():
        try:
            from app.db import get_supabase as _gsb_m
            _sb = _gsb_m()
            from datetime import datetime, timedelta, timezone
            cutoff = (datetime.now(timezone.utc) - timedelta(days=_DISPATCH_HISTORY_RETENTION_DAYS)).isoformat()
            # 1) older than TTL
            _sb.table("dispatch_history").delete().lt("sent_at", cutoff).execute()
            # 2) chapter_clicks retention
            try:
                _clicks_cutoff = (datetime.now(timezone.utc) - timedelta(days=_CHAPTER_CLICKS_RETENTION_DAYS)).isoformat()
                _sb.table("chapter_clicks").delete().lt("clicked_at", _clicks_cutoff).execute()
            except Exception as e:
                logger.warn("retention: chapter_clicks cleanup failed", err=str(e)[:120])
            # 3) cron_run_status retention
            try:
                _cron_cutoff = (datetime.now(timezone.utc) - timedelta(days=_CRON_RUN_STATUS_RETENTION_DAYS)).isoformat()
                _sb.table("cron_run_status").delete().lt("created_at", _cron_cutoff).execute()
            except Exception as e:
                logger.warn("retention: cron_run_status cleanup failed", err=str(e)[:120])
            # 4) failed_dispatches retention (resolved/permanent only)
            try:
                _failed_cutoff = (datetime.now(timezone.utc) - timedelta(days=_FAILED_DISPATCHES_RETENTION_DAYS)).isoformat()
                _sb.table("failed_dispatches").delete().in_("status", ["resolved", "permanent_failure"]).lt("updated_at", _failed_cutoff).execute()
            except Exception as e:
                logger.warn("retention: failed_dispatches cleanup failed", err=str(e)[:120])
            # 2) per-series cap: keep newest N per (title_key, source)
            #    (two-step: list overflowing keys, delete oldest beyond cap)
            try:
                _over = (
                    _sb.table("dispatch_history")
                    .select("title_key, source")
                    .execute()
                )
                from collections import Counter
                _cnt = Counter((r.get("title_key"), r.get("source")) for r in (_over.data or []))
                _bad = {k: v for k, v in _cnt.items() if v > _RETENTION_MAX_PER_SERIES}
                for (tk, src), n in _bad.items():
                    _keep = (
                        _sb.table("dispatch_history")
                        .select("sent_at")
                        .eq("title_key", tk)
                        .eq("source", src)
                        .order("sent_at", desc=True)
                        .limit(_RETENTION_MAX_PER_SERIES)
                        .execute()
                    )
                    _cutoff_ts = (_keep.data or [{}])[-1].get("sent_at") if _keep.data else None
                    if _cutoff_ts:
                        _sb.table("dispatch_history").delete().eq("title_key", tk).eq("source", src).lt("sent_at", _cutoff_ts).execute()
            except Exception:
                pass
            # 3) K2 FIX: Clean up stale dispatch_claims (older than 48h)
            #    These accumulate when dispatch() fails mid-run or when
            #    do_dispatch=False runs never call complete_dispatch_claim()
            try:
                _claims_cutoff = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
                # Delete by expires_at (active claims have future expires_at)
                _stale = _sb.table("dispatch_claims").delete().lt("expires_at", _claims_cutoff).execute()
                _stale_count = len(_stale.data) if _stale.data else 0
                # Also clean NULL created_at legacy rows
                _null = _sb.table("dispatch_claims").delete().is_("created_at", "null").execute()
                _null_count = len(_null.data) if _null.data else 0
                if _stale_count or _null_count:
                    logger.info("retention: cleaned stale dispatch_claims", expired=_stale_count, null_created=_null_count)
            except Exception as e:
                logger.warn("retention: stale claims cleanup failed", err=str(e)[:160])
            # 4) error_logs retention (30d)
            try:
                from app.storage.error_logs import delete_older_than as _err_prune
                _pruned = _err_prune(days=30)
                if _pruned:
                    logger.info("retention: pruned error_logs", deleted=_pruned, days=30)
            except Exception as e:
                logger.warn("retention: error_logs cleanup failed", err=str(e)[:120])
            logger.info("retention prune done", 
                        dispatch_history_days=_DISPATCH_HISTORY_RETENTION_DAYS, 
                        chapter_clicks_days=_CHAPTER_CLICKS_RETENTION_DAYS,
                        cron_run_status_days=_CRON_RUN_STATUS_RETENTION_DAYS,
                        failed_dispatches_days=_FAILED_DISPATCHES_RETENTION_DAYS)
        except Exception as e:
            logger.error("retention prune failed", exc=e)
        _stop.wait(3600)  # hourly


def _start_retention() -> None:
    global _retention_thread
    if _retention_thread and _retention_thread.is_alive():
        return
    _retention_thread = threading.Thread(target=_retention_loop, daemon=True, name="retention")
    _retention_thread.start()


def start_worker() -> None:
    """Start the background worker thread (idempotent)."""
    global _worker_thread
    if _worker_thread and _worker_thread.is_alive():
        return
    _stop.clear()
    _start_retention()
    # For local dev without Redis, don't spam errors — test connection first.
    try:
        _get_redis().ping()
    except Exception as e:
        logger.warn("redis ping failed — task worker will retry in background (install Redis for queue)", err=str(e)[:120])
    # C1 FIX: Removed signal.signal() calls — lifespan handles shutdown,
    # and these clobbered uvicorn's SIGTERM handler.
    _worker_thread = threading.Thread(target=worker_loop, daemon=True, name="task-worker")
    _worker_thread.start()
    logger.info("task worker started")


def stop_worker(timeout: float = 5.0) -> None:
    """Signal worker + retention threads to stop and wait briefly."""
    _stop.set()
    for _t in (_worker_thread, _retention_thread):
        if _t and _t.is_alive():
            try:
                _t.join(timeout=timeout / 2)
            except Exception:
                pass
