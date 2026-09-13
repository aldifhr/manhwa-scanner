from __future__ import annotations

import threading
import time as _time
import logging

logger = logging.getLogger("tasks.scheduler")

_RSS_SOURCES = ("ikiru", "shinigami", "voratoon")
_SOURCE_INTERVAL_S = 300
_IKIRU_INTERVAL_S = 300
_DISPATCH_INTERVAL_S = 120
_ENRICH_INTERVAL_S = 1200
_ENRICH_MISSING_INTERVAL_S = 1200
_ENRICH_REFRESH_INTERVAL_S = 604800
_VORATOON_COVER_INTERVAL_S = 86400
_FAILED_RETRY_INTERVAL_S = 3600
_DASHBOARD_INTERVAL_S = 600
_RETENTION_INTERVAL_S = 86400
_ALERT_INTERVAL_S = 600
_VSERIES_REFRESH_INTERVAL_S = 3600  # ponytail: v_series MATERIALIZED REFRESH hourly (was 7d via enrich-refresh)

_SCHED_THREAD: threading.Thread | None = None
_stop = threading.Event()


def _scheduler_loop() -> None:
    from app.tasks.queue import enqueue_cron, CRON_QUEUE_KEY, CRON_QUEUE_SET, CRON_PROCESSING_KEY, _get_redis
    from datetime import datetime, timezone

    last_enrich = 0.0
    last_enrich_missing = 0.0
    last_enrich_refresh = 0.0
    last_voratoon_cover = 0.0
    last_vseries = 0.0
    last_dispatch = 0.0
    last_failed_retry = 0.0
    last_dashboard = 0.0
    last_retention = 0.0
    last_alert = 0.0
    logger.info("cron scheduler started",
                sources=_RSS_SOURCES, source_interval=_SOURCE_INTERVAL_S,
                dispatch_interval=_DISPATCH_INTERVAL_S,
                enrich_interval=_ENRICH_INTERVAL_S,
                enrich_missing_interval=_ENRICH_MISSING_INTERVAL_S,
                enrich_refresh_interval=_ENRICH_REFRESH_INTERVAL_S,
                voratoon_cover_interval=_VORATOON_COVER_INTERVAL_S)
    for i, src in enumerate(_RSS_SOURCES):
        try:
            enqueue_cron(f"rss-fetch:{src}", source=src)
        except Exception as e:
            logger.warn("scheduler enqueue failed", src=src, err=str(e)[:120])
        if i < len(_RSS_SOURCES) - 1:
            _stop.wait(20)
    try:
        enqueue_cron("enrich", title="whitelist enrichment")
        last_enrich = _time.monotonic()
    except Exception:
        pass
    last_source = _time.monotonic()
    last_ikiru = _time.monotonic()
    while True:
        try:
            if _stop.wait(_DISPATCH_INTERVAL_S):
                break
            _now = _time.monotonic()
            if _now - last_dispatch >= _DISPATCH_INTERVAL_S:
                try:
                    enqueue_cron("update", title="dispatch chapters")
                    last_dispatch = _now
                except Exception as e:
                    logger.warn("scheduler enqueue dispatch failed", err=str(e)[:120])
            if _now - last_source >= _SOURCE_INTERVAL_S:
                if not _stop.is_set():
                    for src in ("shinigami", "voratoon"):
                        try:
                            logger.info("scheduler enqueue rss-fetch", source=src)
                            enqueue_cron(f"rss-fetch:{src}", source=src)
                        except Exception as e:
                            logger.warn("scheduler enqueue failed", src=src, err=str(e)[:120])
                        _stop.wait(20)
                logger.info("scheduler rss-fetch batch done", sources=("shinigami", "voratoon"))
                last_source = _now
            if _now - last_ikiru >= _IKIRU_INTERVAL_S:
                try:
                    logger.info("scheduler enqueue rss-fetch", source="ikiru")
                    enqueue_cron("rss-fetch:ikiru", source="ikiru")
                    last_ikiru = _now
                except Exception as e:
                    logger.warn("scheduler enqueue failed", src="ikiru", err=str(e)[:120])
            if _now - last_enrich >= _ENRICH_INTERVAL_S:
                try:
                    enqueue_cron("enrich", title="enrichment")
                    enqueue_cron("whitelist-enrich", title="whitelist enrichment")
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
            if _now - last_vseries >= _VSERIES_REFRESH_INTERVAL_S:
                try:
                    enqueue_cron("vseries-refresh")
                    last_vseries = _now
                except Exception:
                    pass
            if _now - last_failed_retry >= _FAILED_RETRY_INTERVAL_S:
                try:
                    enqueue_cron("failed-retry")
                    last_failed_retry = _now
                except Exception:
                    pass
            if _now - last_alert >= _ALERT_INTERVAL_S:
                try:
                    enqueue_cron("dispatch-alert")
                    enqueue_cron("gap-detect")
                    last_alert = _now
                except Exception:
                    pass
            if _now - last_dashboard >= _DASHBOARD_INTERVAL_S:
                try:
                    enqueue_cron("dashboard-snapshot")
                    last_dashboard = _now
                except Exception:
                    pass
            if _now - last_retention >= _RETENTION_INTERVAL_S:
                try:
                    enqueue_cron("retention")
                    last_retention = _now
                except Exception:
                    pass
            try:
                from app.metrics_prometheus import REDIS_QUEUE_DEPTH
                qlen = _get_redis().llen(CRON_QUEUE_KEY)
                REDIS_QUEUE_DEPTH.labels(queue="main").set(qlen)
                REDIS_QUEUE_DEPTH.labels(queue="processing").set(_get_redis().llen(CRON_PROCESSING_KEY))
                REDIS_QUEUE_DEPTH.labels(queue="dlq").set(_get_redis().llen("beag:cron:dlq"))
                if qlen > 50:
                    logger.error("cron queue depth exceeded", queue_length=qlen, threshold=50)
            except Exception:
                pass
            # Update system metrics
            try:
                from app.metrics_prometheus import DB_POOL_SIZE, CIRCUIT_BREAKER_STATE, REDIS_QUEUE_DEPTH
                from app.db_adapter import get_pool_stats
                from app.services.resilience import cb_db, cb_ikiru, cb_shinigami, cb_voratoon
                ps = get_pool_stats()
                DB_POOL_SIZE.labels(state="active").set(ps.get("active", 0))
                DB_POOL_SIZE.labels(state="idle").set(ps.get("idle", 0))
                for name, cb in [("db", cb_db), ("ikiru", cb_ikiru), ("shinigami", cb_shinigami), ("voratoon", cb_voratoon)]:
                    CIRCUIT_BREAKER_STATE.labels(service=name).set({"closed": 0, "half_open": 1, "open": 2}.get(cb.state, 0))
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
