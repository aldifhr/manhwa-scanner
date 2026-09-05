from __future__ import annotations

import hashlib
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth

logger = get_logger("api:continue_reading")
router = APIRouter()

# ponytail: continue_reading now delegates to bookmark (single source) — keep API compat

def _get_session_hash(request: Request) -> str:
    """Extract session hash from cookie."""
    import re
    cookie = request.headers.get("cookie") or ""
    m = re.search(r"(?:^|;\s*)ikiru_dashboard_session=([^;]*)", cookie)
    if not m:
        return ""
    return hashlib.sha256(m.group(1).encode()).hexdigest()[:16]


@router.get("/continue-reading")
async def get_continue_reading(request: Request):
    """Get continue-reading entries for current user. ponytail: delegates to bookmark (single source)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    sid_hash = _get_session_hash(request)
    if not sid_hash:
        return JSONResponse(content={"success": True, "data": {}})
    try:
        from app.services.bookmark import get_bookmarks
        rows = get_bookmarks(sid_hash, limit=100, offset=0)
        # Convert bookmarks → continue_reading entries map
        entries = {}
        for r in rows:
            tk = r.get("title_key") or r.get("titleKey") or ""
            if not tk:
                continue
            entries[tk] = {
                "titleKey": tk,
                "title": r.get("title", ""),
                "cover": r.get("cover"),
                "source": r.get("source", ""),
                "lastChapter": str(r.get("chapter_number", "")),
                "chapterUrl": r.get("chapter_url", ""),
                "seriesUrl": "",
                "origin": "",
                "updatedAt": r.get("updated_at", ""),
            }
        return JSONResponse(content={"success": True, "data": entries})
    except Exception as e:
        logger.warn("get_continue_reading (bookmark) failed", err=str(e)[:120])
        return JSONResponse(content={"success": True, "data": {}})


@router.put("/continue-reading")
async def put_continue_reading(request: Request):
    """Update continue-reading — ponytail: delegates to bookmark, keep compat."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse(content={"success": False, "error": "body must be an object"}, status_code=400)
    if len(body) == 0:
        return JSONResponse(content={"success": True, "data": {}})
    sid_hash = _get_session_hash(request)
    if not sid_hash:
        return JSONResponse(content={"success": False, "error": "no session"}, status_code=401)
    is_batch = False
    if body and all(isinstance(v, dict) and (v.get("titleKey") or v.get("title_key") or v.get("chapterUrl")) for v in body.values()):
        if not (body.get("titleKey") or body.get("title_key") or body.get("chapterUrl")):
            is_batch = True
    if not is_batch and len(body) > 1 and not (body.get("titleKey") or body.get("title_key")):
        sample = next(iter(body.values())) if body else None
        if isinstance(sample, dict) and sample.get("titleKey"):
            is_batch = True
    try:
        from app.services.bookmark import save_bookmark
        if is_batch:
            for k, v in body.items():
                if not isinstance(v, dict):
                    continue
                tk = v.get("titleKey") or v.get("title_key") or k
                if not tk:
                    continue
                cn = v.get("chapterNumber") or 0
                try:
                    cn = float(cn)
                except Exception:
                    cn = 0
                cu = v.get("chapterUrl") or v.get("chapter_url") or ""
                if not cu:
                    continue
                save_bookmark(tk, cn or 1, cu, sid_hash, v.get("source", ""), 0, v.get("title", ""), v.get("cover", ""))
            return JSONResponse(content={"success": True, "data": body})
        title_key = body.get("titleKey") or body.get("title_key") or ""
        if not title_key:
            return JSONResponse(content={"success": False, "error": "titleKey required"}, status_code=400)
        cu = body.get("chapterUrl") or body.get("chapter_url") or ""
        cn = body.get("chapterNumber") or 0
        try:
            cn = float(cn)
        except Exception:
            cn = 0
        save_bookmark(title_key, cn or 1, cu or f"https://x/{title_key}", sid_hash, body.get("source", ""), 0, body.get("title", ""), body.get("cover", ""))
        return JSONResponse(content={"success": True, "data": body})
    except Exception as e:
        logger.warn("put_continue_reading (bookmark) failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/continue-reading/history")
async def get_reading_history(request: Request):
    """Get reading history for current user (all read chapters)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    sid_hash = _get_session_hash(request)
    if not sid_hash:
        return JSONResponse(content={"success": True, "data": {"history": []}})

    try:
        from app.db import get_supabase
        sb = get_supabase()
        res = (
            sb.table("continue_reading")
            .select("entries, updated_at")
            .eq("session_hash", sid_hash)
            .execute()
        )
        if not res.data:
            return JSONResponse(content={"success": True, "data": {"history": []}})

        entries = res.data[0].get("entries", {})
        history = []
        for title_key, entry in entries.items():
            if entry.get("isRead"):
                history.append(entry)

        # Sort by readAt descending (most recent first)
        history.sort(key=lambda x: x.get("readAt", 0), reverse=True)

        return JSONResponse(content={"success": True, "data": {"history": history, "total": len(history)}})
    except Exception as e:
        logger.warn("get_reading_history failed", err=str(e)[:120])
        return JSONResponse(content={"success": True, "data": {"history": []}})


@router.post("/continue-reading/mark-read")
async def mark_as_read(request: Request):
    """Mark a chapter as read."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON"}, status_code=400)

    title_key = body.get("titleKey") or body.get("title_key") or ""
    chapter_url = body.get("chapterUrl") or body.get("chapter_url") or ""

    if not title_key:
        return JSONResponse(content={"success": False, "error": "titleKey required"}, status_code=400)

    sid_hash = _get_session_hash(request)
    if not sid_hash:
        return JSONResponse(content={"success": False, "error": "no session"}, status_code=401)

    try:
        from app.db import get_supabase
        sb = get_supabase()

        # Get existing entries
        res = (
            sb.table("continue_reading")
            .select("entries")
            .eq("session_hash", sid_hash)
            .execute()
        )
        entries = res.data[0].get("entries", {}) if res.data else {}

        # Update or create entry
        if title_key in entries:
            entries[title_key]["isRead"] = True
            entries[title_key]["readAt"] = time.time()
            entries[title_key]["updatedAt"] = time.time()
            if chapter_url:
                entries[title_key]["chapterUrl"] = chapter_url
        else:
            entries[title_key] = {
                "titleKey": title_key,
                "chapter": body.get("chapter", ""),
                "chapterNumber": body.get("chapterNumber", 0),
                "chapterUrl": chapter_url,
                "seriesUrl": body.get("seriesUrl", ""),
                "source": body.get("source", ""),
                "title": body.get("title", ""),
                "isRead": True,
                "readAt": time.time(),
                "updatedAt": time.time(),
            }

        sb.table("continue_reading").upsert(
            {
                "session_hash": sid_hash,
                "entries": entries,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="session_hash",
        ).execute()

        return JSONResponse(content={"success": True, "data": entries[title_key]})
    except Exception as e:
        logger.warn("mark_as_read failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/continue-reading/unread-count")
async def get_unread_count(request: Request):
    """Get count of unread chapters (chapters newer than last read)."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    sid_hash = _get_session_hash(request)
    if not sid_hash:
        return JSONResponse(content={"success": True, "data": {"unreadCount": 0}})

    try:
        from app.db import get_supabase, q
        sb = get_supabase()

        # Get user's reading progress
        res = (
            sb.table("continue_reading")
            .select("entries")
            .eq("session_hash", sid_hash)
            .execute()
        )
        if not res.data:
            return JSONResponse(content={"success": True, "data": {"unreadCount": 0}})

        entries = res.data[0].get("entries", {})
        if not entries:
            return JSONResponse(content={"success": True, "data": {"unreadCount": 0}})

        # Get whitelist to know which series user follows
        wl = sb.table("whitelist").select("title_key, source").execute().data or []
        wl_keys = {(w.get("title_key", ""), w.get("source", "")) for w in wl}

        # Count unread: chapters in recent_chapters that are newer than last read
        unread_count = 0
        for title_key, entry in entries.items():
            last_read_chapter = entry.get("chapterNumber", 0) or 0
            source = entry.get("source", "")

            # Count newer chapters in recent_chapters
            result = q("""
                SELECT COUNT(*) as cnt FROM recent_chapters
                WHERE title_key = %s AND source = %s AND chapter_num > %s
                AND updated_time >= NOW() - INTERVAL '24 hours'
            """, [title_key, source, last_read_chapter])
            unread_count += result[0]["cnt"] if result else 0

        return JSONResponse(content={"success": True, "data": {"unreadCount": unread_count}})
    except Exception as e:
        logger.warn("get_unread_count failed", err=str(e)[:120])
        return JSONResponse(content={"success": True, "data": {"unreadCount": 0}})
