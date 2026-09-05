"""Auto-split from dashboard.py — ponytail: 498L stats snapshot (distinct from analytics 392L), merge when stats+analytics share same aggregation. Auto-split from dashboard.py — stats routes."""
import time
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.utils.request_auth import require_monitor_auth
from app.config import settings
from app.logger import get_logger
from app.storage import health as health_store
from app.utils.text import normalize_title_key
from app.utils.cover_scrub import scrub_cover

# Cache for /sources/health (30s TTL).
_SRC_HEALTH_CACHE: list = [0.0, None]  # [ts, payload]
_SRC_HEALTH_TTL = 30.0

logger = get_logger("api:stats")
router = APIRouter()

# In-memory snapshot cache (15s TTL) — absorbs frontend poll bursts.
_SNAP_CACHE: list = [0.0, None]
_SNAP_TTL = 15.0


def _normalize(title_key: str) -> str:
    return normalize_title_key(title_key or "")


@router.get("/sources/health")
async def sources_health(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    _now = time.monotonic()
    if _SRC_HEALTH_CACHE[0] is not None and (_now - _SRC_HEALTH_CACHE[0]) < _SRC_HEALTH_TTL:
        return JSONResponse(content=_SRC_HEALTH_CACHE[1])
    from app.config import settings as s

    hm = health_store.load_source_health_map(s.SOURCE_KEYS)
    # Return a flat ARRAY (not {results: dict}) so the frontend's
    # /api/reader/sources/health proxy can pass body.data straight to .map()
    results = []
    for src, row in (hm or {}).items():
        results.append({
            "name": src,
            "source": src,
            "status": row.get("status", "healthy"),
            "lastCheck": row.get("last_checked_at") or "",
            "lastSuccess": row.get("last_success_at") or "",
            "uptimePct": 100.0,
            "successRate24h": 0.0,
            "avgResponseTimeMs": row.get("response_time_ms") or 0,
            "consecutiveFailures": row.get("consecutive_failures") or 0,
            "lastError": row.get("last_error"),
            "disabledUntil": row.get("disabled_until"),
            "successesToday": row.get("successes_today") or 0,
            "failuresToday": row.get("failures_today") or 0,
        })
    payload = {"success": True, "data": results}
    _SRC_HEALTH_CACHE[0] = time.monotonic()
    _SRC_HEALTH_CACHE[1] = payload
    return JSONResponse(content=payload)


@router.get("/dashboard-snapshot")
async def dashboard_snapshot(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    # 15s in-memory cache — frontend polls every 30-60s, so this absorbs
    # duplicate bursts and cuts Supabase query volume by ~60%.
    now = time.monotonic()
    if _SNAP_CACHE[0] and (now - _SNAP_CACHE[0]) < _SNAP_TTL:
        return JSONResponse(content=_SNAP_CACHE[1])
    try:
        # Read the materialized singleton row (cron writes it every run).
        # ~20ms vs ~3s for the full recompute. Fallback to compute
        # if the row is missing (cron hasn't run yet / DB hiccup).
        from app.storage import health as health_store
        _row = health_store.read_dashboard_snapshot()
        if _row and _row.get("payload"):
            payload = _row["payload"]
            _SNAP_CACHE[0] = time.monotonic()
            _SNAP_CACHE[1] = payload
            return JSONResponse(content=payload)
        # Fallback: compute live (same as before).
        return JSONResponse(content=await _build_snapshot())
    except Exception:
        # on error, return stale cache if available, else empty
        if _SNAP_CACHE[1] is not None:
            return JSONResponse(content=_SNAP_CACHE[1])
        raise


async def _build_snapshot() -> dict:
    from app.storage import whitelist as wl_store
    from app.storage import health as health_store
    from concurrent.futures import ThreadPoolExecutor

    # Parallelize independent DB reads (PostgREST client is sync; run each
    # query in its own thread so they overlap instead of waterfalling).
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_wl = ex.submit(wl_store.load_whitelist)
        f_hm = ex.submit(health_store.load_source_health_map, settings.SOURCE_KEYS)
        from app.storage import recent_chapters as _rc_store
        f_rc = ex.submit(_rc_store.get_recent_chapters, 24)
        from app.db import get_supabase as _sb
        _sb_client = _sb()
        f_dh = ex.submit(
            lambda: _sb_client.table("dispatch_history")
            .select("chapter_url, title_key, source, sent_at, chapter_title")
            .gte("sent_at", (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat())
            .order("sent_at", desc=True)
            .limit(500)
            .execute()
        )
        f_cron = ex.submit(
            lambda: _sb_client.table("cron_run_status")
            .select("*")
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        rows = f_wl.result()
        raw_hm = f_hm.result()
        rc_24h = f_rc.result()
        dh_all = f_dh.result()
        cron_stats = (f_cron.result().data) or []
    # Normalize source health to camelCase (same shape as /api/sources/health)
    def _norm_src(src: str, row: dict) -> dict:
        return {
            "name": src,
            "source": src,
            "status": row.get("status", "healthy"),
            "lastCheck": row.get("last_checked_at") or "",
            "lastSuccess": row.get("last_success_at") or "",
            "responseTime": row.get("response_time_ms") or 0,
            "avgResponseTimeMs": row.get("response_time_ms") or 0,
            "uptimePct": 100.0,
            "successRate24h": row.get("successes_today", 0),
            "successesToday": row.get("successes_today", 0),
            "failuresToday": row.get("failures_today", 0),
            "consecutiveFailures": row.get("consecutive_failures", 0),
            "lastError": row.get("last_error"),
            "disabledUntil": row.get("disabled_until"),
        }
    hm = {src: _norm_src(src, row) for src, row in (raw_hm or {}).items()}
    overview = {
        "totalChaptersSent": 0,
        "totalMangaTracked": len(rows),
        "averageChaptersPerDay": 0.0,
        "avgCronDuration": 0.0,
    }
    recent_chapters_list = []
    recent_feed: list[dict] = []
    cron_status_data = None
    try:
        dh_rows = dh_all.data or []
        dh_count = len(dh_rows)
        # recent 10 for the card
        dh_recent = dh_rows[:10]
        dh_urls = [r["chapter_url"] for r in dh_recent if r.get("chapter_url")]
        # Normalize shinigami URLs to current base so dispatch_history rows
        # still match recent_chapters after domain migration (f.shinigami.asia -> 11.shinigami.asia).
        from app.utils.text import normalize_shinigami_url as _norm_sh_url
        dh_urls = [_norm_sh_url(u) or u for u in dh_urls]
        rc_by_url = {}
        wl_meta: dict[tuple[str, str], dict] = {}
        if dh_urls:
            rc = (
                _sb_client.table("recent_chapters")
                .select("chapter_url, title_key, title, chapter, cover, source, origin, series_url")
                .in_("chapter_url", dh_urls)
                .execute()
            )
            for r in (rc.data or []):
                if r.get("chapter_url"):
                    rc_by_url[r["chapter_url"]] = r
            # Enrich from whitelist (status/rating/description per (title_key, source))
            tks = [r.get("title_key") for r in (rc.data or []) if r.get("title_key")]
            if tks:
                try:
                    wl_res = (
                        _sb_client.table("whitelist")
                        .select("title_key, source, status, rating, description")
                        .in_("title_key", tks)
                        .execute()
                    )
                    for m in (wl_res.data or []):
                        wl_meta[(m.get("title_key", ""), m.get("source", ""))] = m
                except Exception:
                    pass
        for r in dh_recent:
            _raw_url = r.get("chapter_url") or ""
            _norm_url = _norm_sh_url(_raw_url) or _raw_url
            rc = rc_by_url.get(_norm_url) or rc_by_url.get(_raw_url) or {}
            tk = rc.get("title_key") or r.get("title_key") or ""
            src = rc.get("source") or r.get("source") or ""
            meta = wl_meta.get((tk, src), {})
            title = (
                rc.get("title")
                or r.get("chapter_title")
                or r.get("title_key")
                or "Untitled"
            )
            # Avoid using raw chapter string as title when metadata is missing.
            if not rc and title not in (r.get("title_key") or ""):
                title = r.get("title_key") or title
            chapter = rc.get("chapter") or (r.get("chapter_title") or "")
            try:
                chapter_number = float(str(chapter).strip()) if str(chapter).strip() else 0.0
            except Exception:
                chapter_number = 0.0
            recent_chapters_list.append({
                "title": title,
                "titleKey": rc.get("title_key") or r.get("title_key") or "",
                "chapterLabel": str(chapter),
                "chapterNumber": chapter_number,
                "source": src,
                "sentAt": r.get("sent_at") or "",
                "cover": scrub_cover(rc.get("cover")),
                "origin": rc.get("origin") or meta.get("origin") or "",
                "status": meta.get("status") or "",
                "rating": meta.get("rating") if meta.get("rating") is not None else "",
                "description": meta.get("description") or "",
                "chapterUrl": _norm_url or _raw_url or "",
                "seriesUrl": rc.get("series_url") or r.get("series_url") or "",
            })
        overview["totalChaptersSent"] = dh_count
        # ── Latest Recent feed (RECENT RSS, not queue) ──
        # Shows the freshest chapters from the RSS feed (all sources, excluding
        # JP per the global filter), regardless of notified state. This is a
        # "what's new on the sources" preview for the home dashboard — distinct
        # from queue depth (which is whitelisted-but-unsent only).
        recent_feed = []
        try:
            rc_all = rc_24h  # reuse parallel-fetched 24h window
            # Enrich from whitelist (status/rating/description per (title_key, source))
            feed_tks = [c.get("title_key") for c in rc_all if c.get("title_key")]
            wl_meta_feed: dict[tuple[str, str], dict] = {}
            meta_map_feed: dict[str, dict] = {}
            if feed_tks:
                try:
                    wl_res = (
                        _sb_client.table("whitelist")
                        .select("title_key, source, status, rating, description")
                        .in_("title_key", feed_tks)
                        .execute()
                    )
                    for m in (wl_res.data or []):
                        wl_meta_feed[(m.get("title_key", ""), m.get("source", ""))] = m
                except Exception:
                    pass
                try:
                    meta_res = (
                        _sb_client.table("whitelist")
                        .select("title_key, status, rating, description")
                        .in_("title_key", feed_tks)
                        .execute()
                    )
                    for m in (meta_res.data or []):
                        meta_map_feed[m.get("title_key", "")] = m
                except Exception:
                    pass
            # exclude JP (mirrors Recent tab global filter) + keep items with a title
            seen = set()
            # whitelist keys for isWhitelisted flag
            try:
                _wl_rows = wl_store.load_whitelist()
                wl_keys = {(w.get("title_key"), w.get("source")) for w in _wl_rows}
            except Exception:
                wl_keys = set()
            # whitelist keyed by series slug (title_key in that table is a
            # source UUID/slug, NOT the normalized title — same as Recents/whitelist)
            series_slugs = []
            for c in rc_all:
                su = (c.get("series_url") or "").rstrip("/").split("/")[-1]
                if su:
                    series_slugs.append(su)
            meta_map_feed: dict[str, dict] = {}
            if series_slugs:
                try:
                    meta_res = (
                        _sb_client.table("whitelist")
                        .select("title_key, status, rating, description")
                        .in_("title_key", series_slugs)
                        .execute()
                    )
                    for m in (meta_res.data or []):
                        meta_map_feed[m.get("title_key", "")] = m
                except Exception:
                    pass
            for c in rc_all:
                # JP (manga) chapters now INCLUDED in Latest Recent (operator
                # enabled Japanese origin). Previously this skipped them.
                tk = c.get("title_key") or c.get("title") or ""
                u = c.get("url") or c.get("chapter_url") or ""
                key = f"{tk}:{u}"
                if key in seen:
                    continue
                seen.add(key)
                src = c.get("source", "")
                meta = wl_meta_feed.get((tk, src), {})
                _slug = (c.get("series_url") or "").rstrip("/").split("/")[-1]
                mm = meta_map_feed.get(_slug, {})
                # whitelist first (matches Recents), whitelist as fallback
                def _pick(field):
                    return mm.get(field) or meta.get(field) or ""
                recent_feed.append({
                    "title": c.get("title", ""),
                    "titleKey": c.get("title_key", ""),
                    "chapterLabel": str(c.get("chapter") or c.get("chapter_num") or ""),
                    "chapterUrl": c.get("url") or c.get("chapter_url") or "",
                    "source": src,
                    "updatedTime": c.get("updated_time") or "",
                    "cover": scrub_cover(c.get("cover")),
                    "origin": c.get("origin") or "",
                    "status": _pick("status"),
                    "rating": _pick("rating"),
                    "description": _pick("description"),
                    "isWhitelisted": (tk, src) in wl_keys,
                    "seriesUrl": c.get("series_url") or "",
                })
            # newest first
            recent_feed.sort(key=lambda x: x.get("updatedTime") or "", reverse=True)
            recent_feed = recent_feed[:6]
        except Exception:
            recent_feed = []
        # queue depth = whitelisted chapters in recent_chapters(24h) NOT yet notified
        try:
            from app.cron.collect import filter_whitelisted
            from app.cron.dispatch_mod import fcfs_key as _fk, _claimed_titles
            rc_24h_q = rc_24h  # reuse parallel-fetched 24h window
            wl_rows = wl_store.load_whitelist()
            # Source-aware: a chapter counts as queued only if its
            # (title_key, source) is whitelisted. This matches the
            # actual dispatch path (filter_whitelisted) so ikiru +
            # shinigami for the same title don't double-count, and a
            # source the user did NOT whitelist is excluded.
            queued = filter_whitelisted(rc_24h_q, wl_rows) if wl_rows else []
            # Apply latest_sent ceiling (mirrors the send-phase + the
            # /failed-dispatches/queue endpoint): chapters at/below the
            # notified ceiling are NOT pending (already sent / will be
            # skipped by cron). Without this, stale low-numbered chapters
            # (e.g. Buka MBG ch11/13/14, already past latest_sent=27) sit in
            # recent_chapters and show as "pending" forever.
            from app.utils.text import normalize_title_key as _ntk_q
            _ceil_q: dict[tuple[str, str], float] = {}
            for w in (wl_rows or []):
                tk = _ntk_q(w.get("title_key", ""))
                src = w.get("source") or ""
                try:
                    _ls = float(w.get("latest_sent_chapter") or 0)
                except Exception:
                    _ls = 0.0
                if tk:
                    _ceil_q[(tk, src)] = max(_ceil_q.get((tk, src), 0), _ls)
            _pending_raw = []
            for c in queued:
                tk = _ntk_q(c.get("title_key", ""))
                src = c.get("source") or ""
                ceil = _ceil_q.get((tk, src), _ceil_q.get((tk, ""), 0))
                try:
                    ch = float(c.get("chapter_num") or c.get("chapter") or 0)
                except Exception:
                    ch = 0.0
                if ceil and ch <= ceil:
                    continue
                _pending_raw.append(c)
            # Drop ones already sent — use FCFS key (normalized title+chapter),
            # NOT chapter_url. ikiru/shinigami rotate chapter URLs every scrape,
            # so URL-based matching misses chapters that WERE notified under a
            # different (older) URL → false "pending" in the queue depth.
            # This mirrors the actual dispatch path (_claimed_titles), so the
            # displayed queue depth matches what cron will/won't send.
            queued_keys = [_fk(c.get("title", ""), c.get("chapter", "")) for c in _pending_raw]
            claimed_keys = _claimed_titles(list(set(queued_keys))) if queued_keys else set()
            queued = [c for i, c in enumerate(_pending_raw) if queued_keys[i] not in claimed_keys]
            overview["queueLength"] = len(queued)
        except Exception:
            overview["queueLength"] = 0
        # avg cron duration + avg chapters/day from cron_run_status (per-run stats)
        # (cron_stats already fetched in parallel at top of function)
        try:
            stats_rows = cron_stats
            if stats_rows:
                total_sent = 0
                durations = []
                days = set()
                for s in stats_rows:
                    try:
                        total_sent += int(s.get("chapters_sent") or 0)
                    except (TypeError, ValueError):
                        pass
                    dur = s.get("duration")
                    if dur is not None:
                        try:
                            durations.append(float(dur))
                        except (TypeError, ValueError):
                            pass
                    ts = s.get("created_at")
                    if ts:
                        days.add(ts[:10])
                overview["avgCronDuration"] = round(sum(durations) / len(durations), 1) if durations else 0.0
                overview["averageChaptersPerDay"] = round(total_sent / max(1, len(days)), 1)
        except Exception:
            pass
        # cronStatus from most recent run (cron_stats[0] from parallel fetch).
        # NOTE: the latest cycle may legitimately have 0 sent/matched (no new
        # releases since the last fetch). That is NOT a failure — but showing
        # only the 0/0 cycle makes the panel look broken. So we also surface
        # lastDelivery: the most recent run that actually dispatched >0
        # chapters, proving the pipeline works. Frontend shows both.
        cron_status_data = None
        last_delivery = None
        try:
            if cron_stats:
                lr = cron_stats[0]
                cron_status_data = {
                    "outcome": "ok" if lr.get("status") == "ok" else "error",
                    "timestamp": lr.get("created_at")
                    or lr.get("updated_at")
                    or datetime.now(timezone.utc).isoformat(),
                    "duration": lr.get("duration"),
                    "matched": lr.get("matched") or 0,
                    "sent": lr.get("chapters_sent") or 0,
                }
                # Most recent run with chapters_sent > 0 (real delivery proof).
                for _r in cron_stats:
                    try:
                        _sent = int(_r.get("chapters_sent") or 0)
                    except (TypeError, ValueError):
                        _sent = 0
                    if _sent > 0:
                        last_delivery = {
                            "outcome": "ok" if _r.get("status") == "ok" else "error",
                            "timestamp": _r.get("created_at")
                            or _r.get("updated_at")
                            or datetime.now(timezone.utc).isoformat(),
                            "duration": _r.get("duration"),
                            "matched": _r.get("matched") or 0,
                            "sent": _r.get("chapters_sent") or 0,
                        }
                        break
        except Exception:
            pass
    except Exception:
        pass
    # Provider metrics for the status page — built from source_health
    # (ikiru/shinigami telemetry: status, resp time, daily
    # successes/failures). FE reads health.providerMetrics.
    provider_metrics = [
        {
            "source": src,
            "status": h.get("status", "healthy"),
            "responseTime": h.get("responseTime") or h.get("avgResponseTimeMs") or 0,
            "successesToday": h.get("successesToday", 0),
            "failuresToday": h.get("failuresToday", 0),
            "lastSuccess": h.get("lastSuccess") or "",
        }
        for src, h in (hm or {}).items()
    ]
    payload = {
        "success": True,
        "data": {
            "overview": overview,
            "sourceHealth": hm,
            "health": {"providerMetrics": provider_metrics},
            "recentChapters": recent_chapters_list,
            "recentFeed": recent_feed,
            "whitelistCount": len(rows),
            "queueLength": overview["queueLength"],
            "cronStatus": cron_status_data,
            "lastDelivery": last_delivery,
        },
    }
    _SNAP_CACHE[0] = time.monotonic()
    _SNAP_CACHE[1] = payload
    return payload


def build_snapshot_sync() -> dict:
    """Run the (async) snapshot builder from a sync context (cron).

    Reuses the exact same computation as the API endpoint, so the
    persisted singleton row matches what /api/dashboard-snapshot returns.

    C3 FIX: Detect running event loop and run in thread to avoid
    asyncio.run() from running loop RuntimeError.
    """
    import asyncio
    try:
        asyncio.get_running_loop()
        # We're inside a running loop — run snapshot in a separate thread
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(asyncio.run, _build_snapshot()).result()
    except RuntimeError:
        # No running loop — safe to call asyncio.run()
        return asyncio.run(_build_snapshot())
