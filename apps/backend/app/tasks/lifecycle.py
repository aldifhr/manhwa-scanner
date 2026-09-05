from __future__ import annotations

import json
import logging
import threading
import time as _time

from app.tasks.queue import _get_redis, QUEUE_KEY, DLQ_KEY, CRON_QUEUE_KEY
from app.tasks.retention import _retention_loop

logger = logging.getLogger("tasks.lifecycle")

_worker_thread: threading.Thread | None = None
_retention_thread: threading.Thread | None = None
_stop = threading.Event()


def do_add(item: dict) -> None:
    """Process one add-to-whitelist job directly (no Redis)."""
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
            do_add(payload)
        else:
            logger.warn("unknown job kind", kind=payload.get("kind"))
        return True
    except Exception as e:
        logger.error("task failed", kind=payload.get("kind"), exc=e)
        return False


def run_cron_inline(action: str) -> None:
    """Run pipeline inline (used by cron worker when Redis is down)."""
    is_scrape = action.startswith("rss-fetch")
    source = action.split(":", 1)[1] if ":" in action else None
    do_dispatch = not is_scrape

    if action in ("enrich", "enrich-missing", "enrich-refresh"):
        from app.cron.enrich_resync import enrich_recent_chapters, enrich_stale_series_meta
        if action == "enrich":
            stats = enrich_recent_chapters(limit=100)
        elif action == "enrich-missing":
            stats = enrich_recent_chapters(limit=100, miss_only=True)
        else:
            stats = enrich_stale_series_meta(stale_days=7, limit=50)
        logger.info("cron enrich done", action=action, stats=stats)
        return

    if action == "voratoon-cover":
        from app.cron.enrich_resync import enrich_voratoon_covers
        stats = enrich_voratoon_covers(limit=50)
        logger.info("cron voratoon-cover done", **stats)
        return

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            from app.cron.pipeline import run_pipeline
            run_pipeline(action=action, do_dispatch=do_dispatch)
            return
        except Exception as e:
            if attempt < max_attempts:
                wait = 2 ** attempt
                logger.warn("cron run failed, retrying", action=action, attempt=attempt, wait=wait, err=str(e)[:120])
                _time.sleep(wait)
            else:
                logger.error("cron run failed, moving to DLQ", action=action, attempts=max_attempts, exc=e)
                try:
                    _get_redis().rpush(DLQ_KEY, json.dumps({"action": action, "error": str(e)[:200], "attempts": max_attempts}))
                except Exception:
                    pass
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
    """Blocking worker for the cron queue (ROLE=cron process only)."""
    logger.info("cron worker started")
    while not _stop.is_set():
        try:
            result = _get_redis().blpop(CRON_QUEUE_KEY, timeout=5)
        except Exception as e:
            logger.warn("redis unavailable in cron worker, retrying", err=str(e)[:160])
            _stop.wait(10)
            continue
        if not result:
            continue
        _key, raw = result
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("bad cron payload, dropping", raw=raw[:200])
            continue
        run_cron_inline(item.get("action", "update"))


def get_cron_status() -> dict:
    """Snapshot of the internal cron scheduler for the /cron monitor page."""
    from datetime import datetime, timezone
    from app.tasks.scheduler import _SCHED_THREAD

    status: dict = {
        "scheduler_alive": bool(_SCHED_THREAD and _SCHED_THREAD.is_alive()),
        "source_interval_s": 600,
        "dispatch_interval_s": 120,
        "enrich_interval_s": 3600,
        "enrich_missing_interval_s": 3600,
        "enrich_refresh_interval_s": 604800,
        "voratoon_cover_interval_s": 86400,
        "sources": ["ikiru", "shinigami", "voratoon"],
        "now": datetime.now(timezone.utc).isoformat(),
    }
    try:
        r = _get_redis()
        status["redis_up"] = bool(r.ping())
        status["queue_depth"] = int(r.llen(CRON_QUEUE_KEY))
    except Exception:
        status["redis_up"] = False
        status["queue_depth"] = -1
    status["is_processing"] = bool(
        status.get("scheduler_alive") and status.get("queue_depth", 0) > 0
    )
    try:
        r = _get_redis()
    except Exception:
        r = None
    src_status: dict[str, object] = {}
    try:
        from app.db import get_supabase
        sb = get_supabase()
        for src in ("ikiru", "shinigami", "voratoon"):
            last = None
            if r is not None:
                try:
                    hb = r.get(f"cron:last_scrape:{src}")
                    if hb:
                        last = hb.decode() if isinstance(hb, bytes) else str(hb)
                except Exception:
                    pass
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
            next_in = None
            if last:
                try:
                    lt = datetime.fromisoformat(last) if isinstance(last, str) else last
                    if lt.tzinfo is None:
                        lt = lt.replace(tzinfo=timezone.utc)
                    elapsed = (datetime.now(timezone.utc) - lt).total_seconds()
                    next_in = max(0, 600 - elapsed)
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
            result = _get_redis().blpop(QUEUE_KEY, timeout=5)
            _fail_streak = 0
        except Exception as e:
            _fail_streak += 1
            if _fail_streak <= 3:
                logger.warn("redis unavailable, retrying (dev: install Redis or set REDIS_URL)", err=str(e)[:160])
            else:
                logger.debug("redis still unavailable", err=str(e)[:80])
            wait = min(5 * (2 ** min(_fail_streak - 1, 3)), 30)
            _stop.wait(wait)
            continue
        if not result:
            continue
        _key, raw = result
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("bad payload, dropping", raw=raw[:200])
            continue
        ok = _process(item)
        if not ok:
            item["attempts"] = item.get("attempts", 0) + 1
            if item["attempts"] >= 3:
                try:
                    _get_redis().rpush(DLQ_KEY, json.dumps(item))
                    logger.error("job moved to DLQ", title=item.get("title"))
                except Exception as e:
                    logger.error("DLQ push failed", exc=e)
            else:
                try:
                    _get_redis().rpush(QUEUE_KEY, json.dumps(item))
                except Exception as e:
                    logger.error("re-enqueue failed", exc=e)


def start_worker() -> None:
    """Start the background worker thread (idempotent)."""
    global _worker_thread, _retention_thread
    if _worker_thread and _worker_thread.is_alive():
        return
    _stop.clear()
    _retention_thread = threading.Thread(target=_retention_loop, args=(_stop,), daemon=True, name="retention")
    _retention_thread.start()
    try:
        _get_redis().ping()
    except Exception as e:
        logger.warn("redis ping failed — task worker will retry in background (install Redis for queue)", err=str(e)[:120])
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
