"""Auto-split from dashboard.py — catalog routes."""
import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.config import settings
from app.utils.request_auth import require_monitor_auth
from app.utils.cover_scrub import cover_ref
from app.logger import get_logger
from app.storage import whitelist as wl_store
from app.utils.origin import normalize_origin
from app.utils.text import normalize_title_key
logger = get_logger("api:catalog")
router = APIRouter()


def _ikiru_catalog_rows(q: str, wl_keys: set[str]) -> list[dict]:
    """Search the ikiru catalogue.

    Unlike voratoon there is no relay to read from: the VPS reaches ikiru
    directly (curl_cffi), so this queries the live API. Only the shelves we
    ingest are searched (MANHWA/MANHUA — see _SHELVES), so JP does not leak
    back in through search after being dropped from collection.

    Matching is client-side because the API has no search-by-title endpoint we
    rely on; the catalogue is small enough (a few hundred rows per shelf) to
    filter locally.
    """
    from app.scrapers.ikiru import _SHELVES, TYPE_TO_ORIGIN, get_library_page
    from app.utils.text import slugify_title_key

    needle = (q or "").strip().lower()
    if not needle:
        return []

    rows: list[dict] = []
    seen: set[str] = set()
    for shelf in _SHELVES:
        content_type, origin = TYPE_TO_ORIGIN[shelf]
        page = 1
        scanned = 0
        while page <= 20:
            batch, total = get_library_page(page=page, limit=50, manga_type=shelf)
            if not batch:
                break
            for m in batch:
                if not isinstance(m, dict):
                    continue
                title = str(m.get("title") or "").strip()
                slug = str(m.get("slug") or "").strip()
                if not title or not slug or slug in seen:
                    continue
                if needle not in title.lower():
                    continue
                seen.add(slug)
                meta = m.get("metadata") or {}
                genres = [
                    str(g.get("name"))
                    for g in (meta.get("genre") or [])
                    if isinstance(g, dict) and g.get("name")
                ]
                tk = slugify_title_key(title)
                rows.append(
                    {
                        "title": title,
                        "titleKey": tk,
                        "cover": str(m.get("featuredImage") or ""),
                        "source": "ikiru",
                        "url": f"{settings.IKIRU_PUBLIC_BASE}/manga/{slug}",
                        "origin": origin,
                        "type": content_type,
                        "rating": meta.get("score"),
                        "genres": genres,
                        "description": str(m.get("description") or "").strip(),
                        "isInWhitelist": normalize_title_key(tk) in wl_keys,
                    }
                )
            scanned += len(batch)
            if total and scanned >= total:
                break
            page += 1
    return rows


def _voratoon_catalog_rows(q: str, wl_keys: set[str]) -> list[dict]:
    """Search relay-held voratoon data.

    api.voratoon.com is Cloudflare-blocked from this VPS, so catalog search
    can only cover what the relay cron has already fetched (slug map +
    recent catalogue pages). Series that never updated recently will not
    appear here — add those from the feed card instead.
    """
    import json as _json
    from pathlib import Path as _Path
    from app.scrapers.voratoon import _derive_format
    from app.utils.text import slugify_title_key

    base = _Path(__file__).resolve().parents[3] / "relay" / "voratoon"
    by_title: dict[str, dict] = {}
    try:
        smap = _json.loads((base / "slug_map.json").read_text())
    except Exception:
        smap = {}
    if isinstance(smap, dict):
        for title, row in smap.items():
            if not isinstance(row, dict) or not row.get("slug"):
                continue
            slug = str(row["slug"])
            ctype, origin = _derive_format(row.get("format"))
            by_title[str(title)] = {
                "title": str(title),
                "titleKey": slugify_title_key(str(title)),
                "cover": row.get("cover") or "",
                "rating": row.get("rating"),
                "origin": origin,
                "type": ctype,
                "genres": [],
                "description": "",
                "url": f"https://v4.voratoon.com/series/{slug}",
            }
    try:
        upd = _json.loads((base / "relay_updates.json").read_text())
    except Exception:
        upd = {}
    rows_in = (upd or {}).get("items") if isinstance(upd, dict) else None
    if isinstance(rows_in, list):
        for it in rows_in:
            if not isinstance(it, dict):
                continue
            title = str(it.get("title") or "").strip()
            if not title:
                continue
            row = by_title.get(title) or {
                "title": title,
                "titleKey": str(it.get("title_key") or slugify_title_key(title)),
                "cover": "",
                "rating": None,
                "origin": "",
                "type": "",
                "genres": [],
                "description": "",
                "url": str(it.get("series_url") or ""),
            }
            by_title[title] = row
            for k in ("cover", "rating", "origin", "type", "description", "genres"):
                if it.get(k) and not row.get(k):
                    row[k] = it.get(k)
            if it.get("series_url") and not row.get("url"):
                row["url"] = str(it["series_url"])

    ql = (q or "").strip().lower()
    out: list[dict] = []
    for title, row in by_title.items():
        if ql and ql not in title.lower():
            continue
        tk = str(row.get("titleKey") or slugify_title_key(title))
        out.append(
            {
                "title": title,
                "titleKey": tk,
                "cover": row.get("cover") or "",
                "source": "voratoon",
                "url": row.get("url") or f"https://v4.voratoon.com/series/{tk}",
                "origin": row.get("origin") or "",
                "isInWhitelist": tk in wl_keys or normalize_title_key(title) in wl_keys,
                "rating": row.get("rating"),
                "genres": row.get("genres") or [],
                "description": row.get("description") or "",
            }
        )
    out.sort(key=lambda r: r["title"].lower())
    return out[:10]


@router.get("/catalog/search")
async def catalog_search(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    q = request.query_params.get("q", "")
    from app.scrapers import shinigami

    # A removed source was still referenced here,
    # so the endpoint raised NameError on every request. shinigami is the only
    # scraper left with a search API, so that is all this searches.
    raw = await asyncio.to_thread(shinigami.search_shinigami_api, q, 10)
    for _r in raw:
        if not _r.get("source"):
            _perm = _r.get("permalink", "") or ""
            _r["source"] = "shinigami"
    from app.storage import whitelist as _wl_store
    _wl_keys = set()
    try:
        for _w in (_wl_store.load_whitelist() or []):
            _tk = _w.get("title_key") or ""
            if _tk:
                _wl_keys.add(normalize_title_key(_tk))
    except Exception:
        pass
    results = []
    for r in raw:
        src = r.get("source") or ""
        title = r.get("title") or ""
        if not title:
            continue
        slug = r.get("slug") or r.get("permalink", "").rstrip("/").split("/")[-1] or normalize_title_key(title)
        _raw_origin = r.get("origin") or r.get("type") or []
        if isinstance(_raw_origin, list):
            _raw_origin = _raw_origin[0] if _raw_origin else ""
        _origin_cc = normalize_origin(_raw_origin)
        if not _origin_cc:
            _origin_cc = "JP" if src == "shinigami" else ""
        _is_wl = normalize_title_key(slug) in _wl_keys
        results.append({
            "title": title,
            "titleKey": slug,
            "cover": cover_ref(slug),
            "source": src,
            "url": r.get("permalink") or r.get("url") or r.get("series_url") or (f"{settings.SHINIGAMI_PUBLIC_BASE}/series/{r.get('manga_id')}" if src == "shinigami" and r.get("manga_id") else ""),
            "origin": _origin_cc,
            "isInWhitelist": _is_wl,
        })
    try:
        results.extend(_voratoon_catalog_rows(q, _wl_keys))
    except Exception as exc:  # noqa: BLE001 — search must not die on relay IO
        logger.debug("voratoon catalog search skipped", err=str(exc)[:120])
    # Skip disabled sources: ikiru is off, but its catalogue walk still costs
    # ~3.5s per keystroke (it pages the live API client-side), which is the
    # whole latency of this endpoint — and it can only ever return rows for a
    # source the app no longer ingests.
    if "ikiru" in settings.active_sources:
        try:
            results.extend(_ikiru_catalog_rows(q, _wl_keys))
        except Exception as exc:  # noqa: BLE001 — search must not die on upstream IO
            logger.debug("ikiru catalog search skipped", err=str(exc)[:120])
    return JSONResponse(content={"success": True, "data": {"results": results, "count": len(results)}})


@router.get("/catalog/stats")
async def catalog_stats(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    rows = wl_store.load_whitelist() or []
    total = len(rows)
    status_distribution: dict[str, int] = {}
    source_distribution: dict[str, int] = {}
    rating_buckets = {"0-2": 0, "3-5": 0, "6-8": 0, "9-10": 0, "unrated": 0}
    total_with_rating = 0
    for r in rows:
        src = r.get("source") or "unknown"
        source_distribution[src] = source_distribution.get(src, 0) + 1
        rating = r.get("rating")
        if rating is None:
            rating_buckets["unrated"] += 1
        else:
            try:
                v = float(rating)
                total_with_rating += 1
                if v < 3:
                    rating_buckets["0-2"] += 1
                elif v < 6:
                    rating_buckets["3-5"] += 1
                elif v < 9:
                    rating_buckets["6-8"] += 1
                else:
                    rating_buckets["9-10"] += 1
            except Exception:
                rating_buckets["unrated"] += 1
    return JSONResponse(
        content={
            "success": True,
            "data": {
                "total": total,
                "statusDistribution": status_distribution,
                "sourceDistribution": source_distribution,
                "ratingBuckets": {"buckets": rating_buckets, "totalWithRating": total_with_rating},
            },
            "whitelist_count": total,
        }
    )
