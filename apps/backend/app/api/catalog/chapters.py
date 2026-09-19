"""Catalog chapters — GET /catalog/chapters/{title_key}."""
import re
import urllib.parse as _up
import time as _qtime
from collections import OrderedDict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.utils.text import deslugify_title_key, normalize_title_key
from app.logger import get_logger
from app.storage import whitelist as wl_store
from app.utils.request_auth import safe_error, require_monitor_auth

logger = get_logger("api:catalog:chapters")
router = APIRouter()

_CAT_CH_CACHE: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_CAT_CH_MAX = 100
_CAT_CH_TTL = 60.0


@router.get("/catalog/chapters/{title_key}")
async def catalog_chapters(title_key: str, request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase
    tk = _up.unquote(title_key)
    if ":" in tk:
        tk = tk.split(":", 1)[0]
    tk = deslugify_title_key(tk)
    norm_tk = normalize_title_key(tk)
    _now = _qtime.monotonic()
    _cached = _CAT_CH_CACHE.get(norm_tk)
    if _cached is not None and (_now - _cached[0]) < _CAT_CH_TTL:
        _CAT_CH_CACHE.move_to_end(norm_tk)
        return JSONResponse(content=_cached[1])
    try:
        res = get_supabase().table("recent_chapters").select("title_key, title, source, chapter, chapter_url, cover, series_url, origin, updated_time").eq("title_key", norm_tk).order("updated_time", desc=True).limit(50).execute()
        rows: list[dict] = res.data or []

        def _ch_num(r: dict) -> int:
            c = str(r.get("chapter") or "").strip()
            m = re.search(r"(\d+)", c)
            return int(m.group(1)) if m else 0

        rows.sort(key=_ch_num, reverse=True)
        if not rows:
            try:
                from datetime import datetime, timezone, timedelta
                cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
                dh = get_supabase().table("dispatch_history").select("chapter_url, title_key, source, chapter_title, sent_at, fcfs_key").eq("title_key", norm_tk).gte("sent_at", cutoff).order("sent_at", desc=True).limit(50).execute()
                wl_lookup: dict[str, dict] = {}
                try:
                    for w in (wl_store.load_whitelist() or []):
                        wl_lookup[normalize_title_key(str(w.get("title_key") or ""))] = w
                except Exception:
                    pass
                for r in (dh.data or []):
                    row_tk = r.get("title_key") or norm_tk
                    wl = wl_lookup.get(normalize_title_key(row_tk)) or {}
                    rows.append({"title_key": row_tk, "title": wl.get("title") or "", "source": r.get("source") or "", "chapter": r.get("chapter_title") or "", "chapter_url": r.get("chapter_url") or "", "cover": wl.get("cover") or "", "series_url": wl.get("series_url") or wl.get("url") or "", "origin": wl.get("origin") or "", "updated_time": r.get("sent_at") or ""})
            except Exception:
                pass
        payload = {"success": True, "data": {"results": rows, "total": len(rows), "titleKey": norm_tk}}
        _CAT_CH_CACHE[norm_tk] = (_qtime.monotonic(), payload)
        _CAT_CH_CACHE.move_to_end(norm_tk)
        while len(_CAT_CH_CACHE) > _CAT_CH_MAX:
            _CAT_CH_CACHE.popitem(last=False)
        return JSONResponse(content=payload)
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)
