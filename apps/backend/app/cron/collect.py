"""Source collection orchestrator"""
from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta

# Freshness window for scraped chapters (hours). One source of truth for
# both the API-side adaptive pagination (collect_whitelisted_shinigami_chapters)
# and the post-collect row filter (pipeline._filter_fresh_window), so the two
# can never drift apart and silently disagree about what counts as fresh.
FRESH_WINDOW_HOURS = int(os.getenv("SCRAPE_FRESH_WINDOW_HOURS", "24") or 24)

from app.config import settings
from app.logger import get_logger
from app.utils.text import slugify_title_key
from app.storage import health, whitelist as wl_store
from app.cron.collectors.common import _SOURCE_TIMEOUT
from app.cron.collectors.shinigami import _collect_shinigami_source
from app.cron.collectors.voratoon import _collect_voratoon_source
from app.cron.collectors.ikiru import _collect_ikiru_source
from app.cron.source_result import SourceResult
import time as _time

logger = get_logger("cron:collect")
health_store = health

# How many whitelisted shinigami series one tick may walk.
#
# The walk is serial and costs ~1.8s per series (measured against the live
# API), so 246 whitelisted series need ~452s — which is what made an rss-fetch
# tick take 116-153s and starve the single-worker queue until `update` never
# ran. The budget must therefore fit both _SOURCE_TIMEOUT (120s) and the tick
# interval; 40 series is ~72s, leaving headroom for the other collectors that
# run in the same tick.
#
# Override with SHINIGAMI_WALK_BUDGET for a one-off full sweep.
_WALK_BUDGET_PER_TICK = int(os.getenv("SHINIGAMI_WALK_BUDGET", "40") or 40)
_WALK_CURSOR_KEY = "beag:shinigami_walk_cursor"


def _load_walk_cursor() -> int:
    """Read the rotating walk cursor. Missing/unparsable restarts at 0.

    The walk is idempotent (chapters already sent are filtered by the
    latest_sent ceiling), so a reset costs a repeated pass, never a lost
    chapter.
    """
    try:
        from app.tasks.queue import _get_redis
        v = _get_redis().get(_WALK_CURSOR_KEY)
        n = int(v) if v is not None else 0
        return n if n >= 0 else 0
    except Exception:
        return 0


def _save_walk_cursor(cursor: int) -> None:
    """Persist the cursor. A failure only costs a repeated slice."""
    try:
        from app.tasks.queue import _get_redis
        _get_redis().set(_WALK_CURSOR_KEY, max(0, int(cursor)), ex=86400)
    except Exception as e:
        logger.debug("walk cursor save failed", err=str(e)[:120])


def collect_recent_chapters(
    with_whitelisted_shinigami: bool = False,
    source: str | None = None,
    fetch_meta: bool = True,
) -> tuple[list[dict], dict]:
    _disabled: set[str] = set()
    _env_disabled = (getattr(settings, "DISABLED_SOURCES", "") or "").strip()
    if _env_disabled:
        for _s in _env_disabled.split(","):
            _s = _s.strip().lower()
            if _s:
                _disabled.add(_s)
    try:
        hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
        _now = datetime.now(timezone.utc)
        for src, row in (hm or {}).items():
            du = row.get("disabled_until")
            if du:
                try:
                    if datetime.fromisoformat(du.replace("Z", "+00:00")) > _now:
                        _disabled.add(src)
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass

    items: list[dict] = []
    import time as _t
    _hm: dict[str, dict] = {}
    _now_iso = datetime.now(timezone.utc).isoformat()

    _latest_sent: dict[tuple[str, str], float] = {}
    try:
        from app.db import get_supabase as _gsb_ls
        _wl_ls = _gsb_ls().table("whitelist").select("title_key, source, latest_sent_chapter").execute()
        for _w in (_wl_ls.data or []):
            _tk = slugify_title_key(_w.get("title_key") or "")
            _src = _w.get("source") or ""
            try:
                _ls = float(_w.get("latest_sent_chapter") or 0)
            except (ValueError, TypeError):
                _ls = 0
            if _tk:
                _latest_sent[(_tk, _src)] = max(_latest_sent.get((_tk, _src), 0), _ls)
    except Exception as _e:
        logger.warn("collect: load latest_sent_chapter failed", err=str(_e)[:160])

    def _health_start(src: str) -> float:
        return _t.time()

    def _health_end(src: str, t0: float, ok: bool, err: str | None = None) -> None:
        rt = int((_t.time() - t0) * 1000)
        prev = _hm.get(src) or {}
        consec = 0 if ok else prev.get("consecutive_failures", 0) + 1
        text = (err or "").lower()
        if ok:
            status = "HEALTHY"
        elif any(x in text for x in ("429", "rate limit", "too many requests")):
            status = "RATE_LIMITED"
        elif any(x in text for x in ("403", "forbidden", "cloudflare", "blocked")):
            status = "BLOCKED"
        elif any(x in text for x in ("timeout", "timed out", "connection")):
            status = "DOWN"
        else:
            status = "DEGRADED"
        _hm[src] = {
            "status": status,
            "response_time_ms": rt,
            "successes_today": (prev.get("successes_today", 0) + 1) if ok else prev.get("successes_today", 0),
            "failures_today": (prev.get("failures_today", 0) + 1) if not ok else prev.get("failures_today", 0),
            "consecutive_failures": consec,
            "last_success_at": _now_iso if ok else prev.get("last_success_at"),
            "last_checked_at": _now_iso,
            "last_error": err if not ok else None,
        }
        try:
            from app.metrics_prometheus import track_rss_fetch
            if not ok:
                track_rss_fetch(source=src, item_count=0, error=str(err)[:80])
            else:
                track_rss_fetch(source=src, item_count=len(items))
        except Exception:
            pass

    import concurrent.futures

    def _try_collect(src: str) -> SourceResult:
        started = _time.monotonic()
        try:
            _src_items: list[dict] = []
            if src == "shinigami":
                _src_items = _collect_shinigami_source(_latest_sent, _disabled, fetch_meta)
            elif src == "voratoon":
                _src_items = _collect_voratoon_source(_latest_sent, _disabled, fetch_meta)
            elif src == "ikiru":
                _src_items = _collect_ikiru_source(_latest_sent, _disabled, fetch_meta)
            return SourceResult.ok(src, _src_items, started)
        except Exception as exc:
            logger.warn("collect provider failed", source=src, err=str(exc)[:300])
            return SourceResult.failed(src, started, exc)

    _sources_to_run: list[str] = []
    for _src in ("shinigami", "voratoon", "ikiru"):
        if (source is None or source == _src) and _src not in _disabled:
            _sources_to_run.append(_src)

    if _sources_to_run:
        _t0_map: dict[str, float] = {}

        def _run_phase(sources: list[str]):
            if not sources:
                return
            _executor = concurrent.futures.ThreadPoolExecutor(max_workers=len(sources))
            _futures: dict = {}
            for _src in sources:
                _t0_map[_src] = _health_start(_src)
                logger.info("collect start", source=_src)
                _futures[_executor.submit(_try_collect, _src)] = _src
            try:
                for _future in concurrent.futures.as_completed(_futures, timeout=_SOURCE_TIMEOUT):
                    _src = _futures[_future]
                    _t0 = _t0_map.get(_src, _health_start(_src))
                    try:
                        result = _future.result(timeout=5)
                        if not result.success:
                            _health_end(_src, _t0, False, result.error or "provider failed")
                            logger.warn("collect failed", source=_src, err=result.error or "provider failed")
                            continue
                        items.extend(result.items)
                        _health_end(_src, _t0, True)
                        logger.info("collect done", source=_src, count=len(result.items), response_time_ms=result.latency_ms)
                    except Exception as e:
                        _health_end(_src, _t0, False, str(e)[:300])
                        logger.warn("collect failed", source=_src, err=str(e)[:200])
            except concurrent.futures.TimeoutError:
                for _future, _src in _futures.items():
                    if not _future.done():
                        _health_end(_src, _t0_map.get(_src, _health_start(_src)), False, f"timeout after {_SOURCE_TIMEOUT}s")
                        logger.warn("collect TIMEOUT", source=_src, timeout=_SOURCE_TIMEOUT)
                        try:
                            _future.cancel()
                        except Exception:
                            pass
            finally:
                try:
                    _executor.shutdown(wait=False, cancel_futures=True)
                except TypeError:
                    _executor.shutdown(wait=False)

        _run_phase(_sources_to_run)
    else:
        for _src in ("shinigami",):
            _hm[_src] = {"status": "disabled", "response_time_ms": 0, "successes_today": 0, "failures_today": 0, "consecutive_failures": 0, "last_success_at": None, "last_checked_at": _now_iso, "last_error": "cooldown"}

    _wl = None
    if with_whitelisted_shinigami and "shinigami" not in _disabled:
        try:
            _wl = wl_store.load_whitelist()
            items.extend(collect_whitelisted_shinigami_chapters(_wl))
        except Exception as e:
            logger.warn("collect whitelisted shinigami failed", err=str(e)[:120])

    # Cross-source dedup: same title+chapter from multiple sources → keep first
    from app.services.fcfs import fcfs_key as _fcfs
    _seen_fcfs: set[str] = set()
    _deduped_items: list[dict] = []
    _dup_count = 0
    for it in items:
        _fk = _fcfs(it.get("title", ""), it.get("chapter", ""))
        if _fk in _seen_fcfs:
            _dup_count += 1
            continue
        _seen_fcfs.add(_fk)
        _deduped_items.append(it)
    if _dup_count:
        logger.info("collect: cross-source dedup", removed=_dup_count)
    items = _deduped_items

    try:
        from app.storage import excluded_titles as excl_store
        from app.utils.text import slugify_title_key as _ntk_c
        _excl = excl_store.load_excluded_keys()
        if _excl:
            _before = len(items)
            items = [it for it in items if not ((tk := _ntk_c(it.get("title_key", "") or it.get("title", ""))) and (tk, (it.get("source") or "")) in _excl)]
            _dropped = _before - len(items)
            if _dropped:
                logger.info("collect: dropped excluded titles", count=_dropped)
    except Exception as e:
        logger.warn("collect: exclude filter failed", err=str(e)[:200])

    return items, _hm


def filter_whitelisted(items: list[dict], whitelist: list[dict]) -> list[dict]:
    """Keep items whose (title, source) pair is whitelisted.

    Source-strict, matching the whitelist's own grain: `whitelist` has one row
    per (title_key, source), so subscribing a series on shinigami does not
    subscribe it on voratoon.

    This used to match on the title alone, on the theory that a series is one
    series and FCFS would pick whichever source reported first. In practice that
    sent notifications from sources nobody subscribed to: 18 of 160 dispatches
    (11%) were for a (title, source) pair absent from the whitelist. The user
    sees a voratoon embed for a series they only track on shinigami — and the
    per-source badge on /whitelist disagrees with the notification they got.

    claim_recent_chapters_for_dispatch() and the SQL claim join already work
    per (title_key, source); this function was the one path that did not, which
    is why the bug only showed on some dispatches.
    """
    allowed: set[tuple[str, str]] = set()
    for w in whitelist:
        wk = slugify_title_key(w.get("title_key", ""))
        src = str(w.get("source") or "").lower()
        if wk:
            allowed.add((wk, src))
    result = []
    for it in items:
        tk = slugify_title_key(it.get("title_key", ""))
        src = str(it.get("source") or "").lower()
        if (tk, src) in allowed:
            result.append(it)
    return result


def collect_whitelisted_shinigami_chapters(whitelist: list[dict]) -> list[dict]:
    import random
    ids: list[tuple[str, str, str]] = []
    seen_ids: set[str] = set()
    from app.db import get_supabase as _get_sb
    from app.scrapers import shinigami
    _sb = _get_sb()
    for w in whitelist:
        wk = slugify_title_key(w.get("title_key", ""))
        src = w.get("source")
        if src != "shinigami":
            continue
        v = w.get("url") or w.get("series_url") or w.get("permalink") or ""
        mid = None
        if 'shinigami.asia/' in v:
            seg = v.rstrip('/').split('/')[-1]
            if seg and '-' in seg:
                mid = seg
        if not mid:
            try:
                rc = (_sb.table("recent_chapters").select("series_url").eq("title_key", w.get("title_key", "")).eq("source", "shinigami").neq("series_url", "").limit(1).execute())
                if rc.data:
                    su = rc.data[0].get("series_url") or ""
                    if "shinigami.asia/series/" in su:
                        mid = su.rstrip("/").split("/")[-1]
            except Exception:
                pass
        if not mid:
            continue
        if mid in seen_ids:
            continue
        seen_ids.add(mid)
        ids.append((mid, wk, w.get("title") or wk.replace("_", " ").title()))

    # ── Bound the walk, and rotate through the rest ──
    #
    # This walk is SERIAL and costs ~1.8s per series against the live API.
    # Measured: 246 whitelisted series => ~452s. That is the single reason an
    # rss-fetch tick took 116-153s, which starved the worker (one job at a
    # time) until the `update` job never reached the front of the queue — the
    # 7-hour notification outage.
    #
    # The walk exists only to catch the chapters BETWEEN the latest_sent
    # ceiling and the newest one, because the latest-updates feed collapses a
    # batch release into a single row. So it does not need to cover everything
    # every tick: it takes a bounded slice and resumes from a stored cursor.
    # Worst case a middle chapter waits one full rotation, which is far better
    # than the walk being killed outright and nothing being covered.
    total = len(ids)
    if total == 0:
        return []
    budget = max(1, _WALK_BUDGET_PER_TICK)
    if total > budget:
        start = _load_walk_cursor() % total
        ids = [ids[(start + i) % total] for i in range(budget)]
        _save_walk_cursor((start + len(ids)) % total)
    else:
        _save_walk_cursor(0)

    items: list[dict] = []
    API_CHAPTER_LIMIT = 100
    # Freshness scan: fetch pages only while chapters are still inside the
    # window, so a series that releases 10 or 20 chapters in a day is fully
    # captured, while a quiet series stops at page 1. max_pages stays a hard
    # ceiling. No page count is hardcoded from observation.
    API_MAX_PAGES = int(os.getenv("SHINIGAMI_FRESH_MAX_PAGES", "5") or 5)
    _notified: dict[str, set[float]] = {}
    try:
        from app.db import get_supabase as _gsb2
        _sb2 = _gsb2()
        _wk_list = [wk for _, wk, _ in ids]
        if _wk_list:
            _dh = (_sb2.table("dispatch_history").select("title_key, source, chapter_title").in_("title_key", _wk_list).execute())
            for _row in (_dh.data or []):
                _tk = _row.get("title_key")
                _ct = _row.get("chapter_title")
                try:
                    _cn = float(_ct)
                except (ValueError, TypeError):
                    continue
                _notified.setdefault(f"{_tk}:{_row.get('source')}", set()).add(_cn)
    except Exception as _e:
        logger.warn("shinigami notified-history load failed", err=str(_e)[:120])
    for mid, wk, wtitle in ids:
        chapters = None
        for _att in range(5):
            try:
                chapters = shinigami.get_shinigami_chapters(
                    mid, per_page=API_CHAPTER_LIMIT, max_pages=API_MAX_PAGES, within_hours=FRESH_WINDOW_HOURS
                )
                break
            except Exception as e:
                import time as _bt
                if _att < 4:
                    _sleep = min(2.0 * (_att + 1), 10.0) + random.uniform(0, 1.0)
                    _bt.sleep(_sleep)
                    continue
                logger.warn("whitelisted shinigami api scrape failed", mid=mid, err=str(e)[:120])
        if not chapters:
            continue
        series_url = f"{settings.SHINIGAMI_PUBLIC_BASE}/series/{mid}"
        _sent = _notified.get(f"{wk}:shinigami") or set()
        for ch in chapters:
            num = ch.get("chapter_number") or ch.get("number") or ch.get("chapter")
            ch_id = ch.get("chapter_id") or ch.get("id")
            ch_url = f"{settings.SHINIGAMI_PUBLIC_BASE}/chapter/{ch_id}" if ch_id else (ch.get("url") or "")
            if not ch_url or num is None:
                continue
            if num in _sent:
                continue
            items.append({"title": (wtitle or wk.replace("_", " ").title()).replace("’", "'"), "title_key": wk, "chapter": str(num), "chapter_num": float(num) if str(num).replace(".", "", 1).isdigit() else 0, "url": ch_url, "source": "shinigami", "cover": None, "series_url": series_url, "chapter_url": ch_url, "origin": "", "updated_time": ch.get("release_date") or ch.get("created_at") or "", "release_date": ch.get("release_date") or ""})
    return items
