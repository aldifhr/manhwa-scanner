from __future__ import annotations

import threading
import time as _time
import logging

logger = logging.getLogger("tasks.scheduler")

_RSS_SOURCES = ("ikiru", "shinigami", "voratoon")
_SOURCE_INTERVAL_S = 600
_DISPATCH_INTERVAL_S = 120
_ENRICH_INTERVAL_S = 3600
_ENRICH_MISSING_INTERVAL_S = 3600
_ENRICH_REFRESH_INTERVAL_S = 604800
_VORATOON_COVER_INTERVAL_S = 86400

_SCHED_THREAD: threading.Thread | None = None
_stop = threading.Event()


def _scheduler_loop() -> None:
    from app.tasks.queue import enqueue_cron, CRON_QUEUE_KEY, _get_redis
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
    for i, src in enumerate(_RSS_SOURCES):
        try:
            enqueue_cron(f"rss-fetch:{src}")
        except Exception as e:
            logger.warn("scheduler enqueue failed", src=src, err=str(e)[:120])
        if i < len(_RSS_SOURCES) - 1:
            _stop.wait(20)
    try:
        enqueue_cron("enrich")
        last_enrich = _time.monotonic()
    except Exception:
        pass
    last_source = _time.monotonic()
    while True:
        try:
            if _stop.wait(_DISPATCH_INTERVAL_S):
                break
            _now = _time.monotonic()
            if _now - last_dispatch >= _DISPATCH_INTERVAL_S:
                try:
                    enqueue_cron("update")
                    last_dispatch = _now
                except Exception as e:
                    logger.warn("scheduler enqueue dispatch failed", err=str(e)[:120])
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
            if _now - last_enrich >= _ENRICH_INTERVAL_S:
                try:
                    enqueue_cron("enrich")
                    last_enrich = _now
                except Exception:
                    pass
            if _now - last_enrich_missing >= _ENRICH_MISSING_INTERVAL_S:
                try:
                    enqueue_cron("enrich-missing")
                    last_enrich_missing = _now
                except Exception:
                    pass
            if _now - last_enrich_refresh >= _ENRICH_REFRESH_INTERVAL_S:
                try:
                    enqueue_cron("enrich-refresh")
                    last_enrich_refresh = _now
                except Exception:
                    pass
            if _now - last_voratoon_cover >= _VORATOON_COVER_INTERVAL_S:
                try:
                    enqueue_cron("voratoon-cover")
                    last_voratoon_cover = _now
                except Exception:
                    pass
            try:
                qlen = _get_redis().llen(CRON_QUEUE_KEY)
                if qlen > 50:
                    logger.error("cron queue depth exceeded", queue_length=qlen, threshold=50)
            except Exception:
                pass
        except Exception as e:
            logger.error("scheduler loop crashed, restarting in 30s", exc=e)
            _stop.wait(30)
            last_source = _time.monotonic()


def start_cron_scheduler() -> None:
    global _SCHED_THREAD
    if _SCHED_THREAD and _SCHED_THREAD.is_alive():
        return
    _SCHED_THREAD = threading.Thread(target=_scheduler_loop, daemon=True, name="cron-scheduler")
    _SCHED_THREAD.start()
    logger.info("cron scheduler thread started")
