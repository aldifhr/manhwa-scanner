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
    # public read — series detail chapters (was monitor-only)
    from app.db import get_supabase
    tk = _up.unquote(title_key)
    if ":" in tk:
        tk = tk.split(":", 1)[0]
    # UUID manga_id (shinigami popular) must not be deslugified — dashes are part of the id
    import re as _re2
    if _re2.match(r"^[0-9a-fA-F-]{36}$", tk):
        norm_tk = tk.lower()
        tk = tk
    else:
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
        if not rows:
            # upstream fallback for Popular (not yet in DB) — shinigami UUID / voratoon slug
            try:
                import re as _re3
                _source_q = (request.query_params.get("source") or "").strip().lower()
                is_uuid = bool(_re3.match(r"^[0-9a-fA-F-]{36}$", title_key))
                if _source_q == "voratoon":
                    is_uuid = False
                if is_uuid:
                    from app.scrapers.shinigami import get_shinigami_chapters
                    from app.config import settings as _s
                    chs = get_shinigami_chapters(title_key, per_page=100)
                    for ch in chs[:100]:
                        num = str(ch.get("chapter_number") or ch.get("number") or "")
                        cid = ch.get("chapter_id") or ch.get("id") or ""
                        url = f"{_s.SHINIGAMI_PUBLIC_BASE.rstrip('/')}/chapter/{cid}" if cid else ""
                        rows.append({"title_key": norm_tk, "title": "", "source": "shinigami", "chapter": num, "chapter_url": url, "cover": "", "series_url": f"{_s.SHINIGAMI_PUBLIC_BASE.rstrip('/')}/series/{title_key}", "origin": "KR", "updated_time": ch.get("created_at") or ch.get("updated_at") or ""})
                else:
                    # try voratoon by slug — use list with takeChapter (single detail has no chapters)
                    import httpx as _httpx
                    with _httpx.Client(timeout=10.0) as _c:
                        # try slug param with chapters
                        r = _c.get(f"{__import__('app.config', fromlist=['settings']).settings.VORATOON_API_URL.rstrip('/')}/series", params={"slug": title_key, "take": 1, "page": 1, "includeMeta": "true", "takeChapter": 30}, headers={"Accept": "application/json"})
                        if r.status_code == 200:
                            j = r.json()
                            arr = j.get("data") or []
                            if arr:
                                first = arr[0]
                                data = first.get("data") or {}
                                chs = first.get("chapters") or []
                                for ch in chs[:100]:
                                    idx = str(ch.get("chapterIndex") or ch.get("data", {}).get("index") or ch.get("index") or "")
                                    if not idx:
                                        continue
                                    rows.append({"title_key": norm_tk, "title": data.get("title") or "", "source": "voratoon", "chapter": idx, "chapter_url": f"https://{__import__('app.config', fromlist=['settings']).settings.VORATOON_DOMAIN}/series/{title_key}/chapter/{idx}", "cover": data.get("coverImage") or "", "series_url": f"https://{__import__('app.config', fromlist=['settings']).settings.VORATOON_DOMAIN}/series/{title_key}", "origin": "CN" if (data.get("format") or "").lower()=="manhua" else "KR", "updated_time": ch.get("createdAt") or ch.get("updatedAt") or ""})
                        if not rows:
                            # fallback to single detail (no chapters but keep at least 1 placeholder)
                            try:
                                r2 = _c.get(f"{__import__('app.config', fromlist=['settings']).settings.VORATOON_API_URL.rstrip('/')}/series/{title_key}", headers={"Accept": "application/json"})
                                if r2.status_code == 200:
                                    j2 = r2.json()
                                    data2 = (j2.get("data") or {}).get("data") or {}
                                    total = str(data2.get("totalChapters") or "")
                                    if total:
                                        rows.append({"title_key": norm_tk, "title": data2.get("title") or "", "source": "voratoon", "chapter": total, "chapter_url": f"https://{__import__('app.config', fromlist=['settings']).settings.VORATOON_DOMAIN}/series/{title_key}", "cover": data2.get("coverImage") or "", "series_url": f"https://{__import__('app.config', fromlist=['settings']).settings.VORATOON_DOMAIN}/series/{title_key}", "origin": "CN" if (data2.get("format") or "").lower()=="manhua" else "KR", "updated_time": ""})
                            except Exception:
                                pass
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
