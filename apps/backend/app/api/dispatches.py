"""Failed dispatches API (formerly part of the compat layer)."""
import time as _time
import threading

from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth, require_role_auth, int_safe, safe_error

logger = get_logger("api:dispatches")
router = APIRouter()


@router.get("/failed-dispatches")
async def failed_dispatches(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    source = request.query_params.get("source", "")
    limit = int_safe(request.query_params.get("limit", "50"), 50, max_val=1000)
    offset = int_safe(request.query_params.get("offset", "0"), 0, max_val=100000)
    try:
        q = (
            get_supabase()
            .table("failed_dispatches")
            .select("*", count="exact")
            .order("created_at", desc=True)
            .limit(limit)
            .offset(offset)
        )
        if source:
            q = q.eq("source", source)
        res = q.execute()
        rows = res.data or []

        urls = [r["chapter_url"] for r in rows if r.get("chapter_url")]
        rc_by_url = {}
        if urls:
            try:
                rc_res = (
                    get_supabase()
                    .table("recent_chapters")
                    .select("chapter_url, title_key, title, chapter, cover, series_url")
                    .in_("chapter_url", urls)
                    .execute()
                )
                for r in (rc_res.data or []):
                    if r.get("chapter_url"):
                        rc_by_url[r["chapter_url"]] = r
            except Exception:
                pass
        from app.storage import whitelist as wl_store
        try:
            wl_rows = wl_store.load_whitelist()
            wl_by_key = {w.get("title_key"): w for w in wl_rows}
        except Exception:
            wl_by_key = {}

        results = []
        for r in rows:
            rc = rc_by_url.get(r.get("chapter_url", ""), {})
            tk = r.get("title_key") or rc.get("title_key") or ""
            wl = wl_by_key.get(tk, {})
            title = wl.get("title") or rc.get("title") or tk
            cover = wl.get("cover") or rc.get("cover") or ""
            results.append({
                "id": r.get("chapter_url"),
                "chapterUrl": r.get("chapter_url"),
                "titleKey": tk,
                "title": title,
                "chapter": r.get("chapter_title") or rc.get("chapter") or "",
                "source": r.get("source", ""),
                "cover": cover,
                "seriesUrl": rc.get("series_url", "") or wl.get("series_url", ""),
                "error": r.get("error_message", "") or r.get("error", ""),
                "createdAt": r.get("created_at", ""),
            })

        return JSONResponse(
            content={
                "success": True,
                "data": {
                    "results": results,
                    "total": res.count or len(results),
                    "pageSize": limit,
                    "offset": offset,
                    "totalPages": ((res.count or len(results)) + limit - 1) // limit if limit else 1,
                    "hasMore": (offset + limit) < (res.count or len(results)),
                },
            }
        )
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/failed-dispatches")
async def failed_dispatches_action(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    action = request.query_params.get("action", "")
    try:
        body = await request.json() if request.headers.get("content-length") else {}
    except Exception:
        body = {}
    dispatch_id = body.get("id") if isinstance(body, dict) else None
    if not dispatch_id:
        dispatch_id = request.query_params.get("id")
    if action == "retry" and dispatch_id:
        from app.db import get_supabase
        from app.cron.dispatch_mod import dispatch, _load_channels
        sb = get_supabase()
        fd = sb.table("failed_dispatches").select("*").eq("chapter_url", dispatch_id).execute()
        fd_row = (fd.data or [None])[0]
        if not fd_row:
            return JSONResponse(content={"success": False, "error": "not found"}, status_code=404)
        rc = sb.table("recent_chapters").select("*").eq("chapter_url", dispatch_id).limit(1).execute()
        rc_row = (rc.data or [None])[0] or {}
        item = {
            "title": fd_row.get("title") or rc_row.get("title") or fd_row.get("title_key") or "Untitled",
            "title_key": fd_row.get("title_key") or rc_row.get("title_key") or "",
            "chapter": fd_row.get("chapter") or rc_row.get("chapter") or "",
            "chapter_url": dispatch_id,
            "source": fd_row.get("source") or rc_row.get("source") or "",
            "cover": rc_row.get("cover") or fd_row.get("cover") or "",
            "series_url": rc_row.get("series_url") or fd_row.get("series_url") or "",
            "origin": rc_row.get("origin") or "",
        }
        channels = _load_channels()
        try:
            sent = dispatch([item], channels, f"retry-{int(_time.time())}") if channels else 0
        except Exception as e:
            logger.warn("retry dispatch failed", err=str(e)[:200])
            return JSONResponse(content=safe_error(e), status_code=500)
        if sent > 0:
            # dispatch() already wrote the dispatch_history row (by fcfs_key,
            # dedup-safe) — do NOT re-insert here (that would collide on
            # the chapter_url PK and throw, which previously swallowed the
            # next line and left the failed_dispatches row forever-stuck).
            try:
                sb.table("failed_dispatches").delete().eq("chapter_url", dispatch_id).execute()
            except Exception as _e:
                logger.warn("retry: failed_dispatches delete failed", err=str(_e)[:120])
            return JSONResponse(content={"success": True, "retried": dispatch_id, "sent": sent})
        return JSONResponse(content={"success": False, "error": "dispatch returned 0", "retried": dispatch_id}, status_code=502)
    if action == "retry-all":
        # Reuse the SAME per-action lock as the cron "update" path so a manual
        # retry-all can never overlap a scheduled update (which would
        # double-send chapters — the bug fixed in dispatch dedupe logic).
        # Run in a daemon thread (fire-and-forget) but guarded by the lock.
        from app.api.system import get_cron_lock
        from app.cron.pipeline import run_pipeline

        lock = get_cron_lock("update")
        if not lock.acquire(blocking=False):
            return JSONResponse(
                content={"success": False, "error": "update already running; retry later"},
                status_code=409,
            )
        try:
            run_pipeline(action="update", do_dispatch=True)
        except Exception as e:
            logger.warn("retry-all failed", err=str(e)[:200])
            return JSONResponse(content=safe_error(e), status_code=500)
        finally:
            lock.release()
        return JSONResponse(content={"success": True, "data": {"status": "done"}})
    return JSONResponse(content={"success": False, "error": "unknown action"}, status_code=400)


@router.delete("/failed-dispatches")
async def failed_dispatches_delete(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    chapter_url = request.query_params.get("id", "") or request.query_params.get("chapter_url", "")
    if not chapter_url:
        try:
            body = await request.json()
            chapter_url = body.get("chapter_url") or body.get("id", "")
        except Exception:
            pass
    from app.db import get_supabase

    if not chapter_url:
        return JSONResponse(content={"success": False, "error": "chapter_url or id required"}, status_code=400)
    try:
        get_supabase().table("failed_dispatches").delete().eq("chapter_url", chapter_url).execute()
        get_supabase().table("dispatch_history").delete().eq("chapter_url", chapter_url).execute()
        return JSONResponse(content={"success": True})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


# --- Pending dispatch queue depth ---
_QDEPTH_CACHE: dict = {"ts": 0.0, "data": None}
_QDEPTH_TTL = 10  # seconds


@router.get("/failed-dispatches/queue")
async def failed_queue(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase
    from app.storage import whitelist as _wl
    from app.storage import dispatch as _ds
    from app.storage import recent_chapters as _rc
    from app.cron.collect import filter_whitelisted

    now = _time.time()
    if _QDEPTH_CACHE["data"] is not None and (now - _QDEPTH_CACHE["ts"]) < _QDEPTH_TTL:
        return JSONResponse(content=_QDEPTH_CACHE["data"])

    try:
        items = _rc.get_recent_chapters(hours=24)
        wl_rows = _wl.load_whitelist()
        to_dispatch = filter_whitelisted(items, wl_rows) if wl_rows else []
        # Load latest_sent ceiling per (title_key, source) so we skip chapters
        # already notified (mirrors the send-phase ceiling; otherwise stale
        # low-numbered chapters that were never recorded in dispatch_history
        # show up as "pending" forever).
        from app.utils.text import normalize_title_key as _ntk
        _ceil: dict[tuple[str, str], float] = {}
        for w in (wl_rows or []):
            tk = _ntk(w.get("title_key", ""))
            src = w.get("source") or ""
            try:
                ls = float(w.get("latest_sent_chapter") or 0)
            except Exception:
                ls = 0.0
            if tk:
                _ceil[(_tk := tk, src)] = max(_ceil.get((tk, src), 0), ls)
        urls = [it.get("url") or it.get("chapter_url") for it in to_dispatch if it.get("url") or it.get("chapter_url")]
        claimed = set()
        if urls:
            try:
                claimed |= _ds._claimed_urls(urls)
            except Exception:
                pass
            try:
                dh = (
                    get_supabase()
                    .table("dispatch_history")
                    .select("chapter_url")
                    .in_("chapter_url", urls)
                    .execute()
                )
                claimed |= {r["chapter_url"] for r in (dh.data or [])}
            except Exception:
                pass
            # FCFS-aware: a chapter is "sent" if its (title, chapter) fcfs_key
            # is already in dispatch_history — even when the *URL* differs
            # (ikiru vs shinigami publish the same chapter with different URLs;
            # the faster source wins FCFS and the slower one is correctly
            # skipped, but its distinct URL would otherwise look "pending" here).
            try:
                from app.cron.dispatch_mod import fcfs_key
                pending_keys = [
                    fcfs_key(it.get("title", ""), it.get("chapter", ""))
                    for it in to_dispatch
                    if (it.get("url") or it.get("chapter_url"))
                ]
                if pending_keys:
                    kh = (
                        get_supabase()
                        .table("dispatch_history")
                        .select("fcfs_key")
                        .in_("fcfs_key", pending_keys)
                        .execute()
                    )
                    claimed_keys = {r["fcfs_key"] for r in (kh.data or []) if r.get("fcfs_key")}
                    for it in to_dispatch:
                        u = it.get("url") or it.get("chapter_url")
                        if not u:
                            continue
                        k = fcfs_key(it.get("title", ""), it.get("chapter", ""))
                        if k in claimed_keys:
                            claimed.add(u)
            except Exception:
                pass
        pending = [u for u in urls if u not in claimed]
        # Apply latest_sent ceiling: chapters at/below the notified ceiling
        # are NOT pending (they were already sent / will be skipped by cron).
        ceiling_pending = []
        for it in to_dispatch:
            u = it.get("url") or it.get("chapter_url")
            if not u or u not in pending:
                continue
            tk = _ntk(it.get("title_key", ""))
            src = it.get("source") or ""
            ceil = _ceil.get((tk, src), _ceil.get((tk, ""), 0))
            try:
                ch = float(it.get("chapter_num") or it.get("chapter") or 0)
            except Exception:
                ch = 0.0
            if ceil and ch <= ceil:
                continue  # already sent (ceiling) -> not pending
            ceiling_pending.append(u)
        result = {
            "success": True,
            "data": {
                "depth": len(ceiling_pending),
                "queue": ceiling_pending[:50],
                "total_whitelisted": len(urls),
                "sent": len(urls) - len(ceiling_pending),
            },
        }
        _QDEPTH_CACHE["ts"] = now
        _QDEPTH_CACHE["data"] = result
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)
