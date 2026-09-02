"""Whitelist enrichment — metadata joins and source-API enrichment helpers.

Extracted from whitelist_service.py to separate enrichment logic from CRUD.
"""
from __future__ import annotations

import re
import html

from app.logger import get_logger
from app.utils.text import normalize_title_key
from app.utils.origin import normalize_origin
from app.utils.cover_scrub import scrub_cover

logger = get_logger("services:whitelist_enrichment")


def enrich_whitelist_entry(entry: dict, url: str, source: str, title: str) -> dict:
    """Enrich a whitelist entry with description/cover/genres from source API.

    Called by post_whitelist when fields are missing. Fetches directly from
    source API so the whitelist response immediately has metadata.
    """
    if not entry.get("description") or not entry.get("cover") or not entry.get("genres"):
        try:
            _url_for_meta = entry.get("series_url") or url or ""
            if source == "shinigami" and _url_for_meta:
                _m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", _url_for_meta)
                if _m:
                    from app.scrapers import shinigami as _sh2
                    meta = _sh2.get_shinigami_series_meta(_m.group(1))
                    if meta:
                        for k in ("cover", "rating", "genres", "description", "origin"):
                            if not entry.get(k) and meta.get(k):
                                entry[k] = meta[k]
                        if not entry.get("series_url") and meta.get("series_url"):
                            entry["series_url"] = meta["series_url"]
            elif source == "ikiru" and _url_for_meta:
                _slug = _url_for_meta.rstrip("/").split("/")[-1]
                if "/manga/" in _url_for_meta:
                    _slug = _url_for_meta.split("/manga/")[-1].split("/")[0]
                if _slug and "chapter-" not in _slug:
                    from app.scrapers import ikiru as _ik2
                    meta = _ik2.get_ikiru_series_meta(_slug)
                    if meta:
                        for k in ("cover", "rating", "genres", "description", "series_url"):
                            if not entry.get(k) and meta.get(k):
                                entry[k] = meta[k]
                        if not entry.get("origin") and meta.get("type"):
                            _o = normalize_origin(meta.get("type"))
                            if _o:
                                entry["origin"] = _o
            elif source == "voratoon" and _url_for_meta:
                _m = re.search(r"/series/([^/?#]+)", _url_for_meta)
                if _m:
                    from app.scrapers import voratoon as _vt2
                    try:
                        d = _vt2.fetch_series_detail(_m.group(1))
                        if d:
                            data = d.get("data", {})
                            meta = {
                                "cover": scrub_cover(data.get("coverImage")),
                                
                                "rating": float(data.get("rating")) if data.get("rating") not in (None, "", 0) else 0.0,
                                "genres": [g.get("data", {}).get("name", "") for g in data.get("genres", []) if g.get("data", {}).get("name")],
                                "description": data.get("synopsis", ""),
                                "series_url": f"{settings.VORATOON_API_URL.rstrip(chr(47))}/series/{_m.group(1)}",
                                "type": (data.get("format") or "").lower() or None,
                                "origin": "CN" if (data.get("format") or "").lower() == "manhua" else "KR",
                            }
                            for k in ("cover", "rating", "genres", "description", "series_url", "type", "origin"):
                                if not entry.get(k) and meta.get(k):
                                    entry[k] = meta[k]
                    except Exception:
                        pass
            # Fallback: search by title if still missing
            if (not entry.get("description") or not entry.get("cover")) and title:
                try:
                    if source == "shinigami":
                        from app.scrapers.shinigami import search_shinigami_api, get_shinigami_series_meta as _gsm
                        hits = search_shinigami_api(title, per_page=3)
                        for h in hits:
                            mid = h.get("manga_id")
                            if mid:
                                m2 = _gsm(mid)
                                if m2 and m2.get("description"):
                                    for k in ("cover", "rating", "genres", "description", "origin", "series_url"):
                                        if not entry.get(k) and m2.get(k):
                                            entry[k] = m2[k]
                                    break
                    elif source == "ikiru":
                        from app.scrapers.ikiru import search_ikiru_api, get_ikiru_series_meta as _gim
                        hits = search_ikiru_api(title, per_page=3)
                        for h in hits:
                            slug2 = (h.get("permalink") or "").rstrip("/").split("/")[-1] if h.get("permalink") else h.get("slug")
                            if slug2:
                                m2 = _gim(slug2)
                                if m2 and m2.get("description"):
                                    for k in ("cover", "rating", "genres", "description", "series_url"):
                                        if not entry.get(k) and m2.get(k):
                                            entry[k] = m2[k]
                                    break
                except Exception:
                    pass
        except Exception:
            pass
    return entry


def build_whitelist_mapped_row(r: dict, rc_map: dict, meta_desc: dict, meta_cover: dict, last_notified: dict) -> dict:
    """Build a single whitelist response row with metadata joins.

    Shared by get_whitelist() to map storage rows to API response format.
    rc_map is keyed by (title_key, source) so each whitelist row (voratoon
    vs shinigami for the same title) gets its OWN recent_chapters
    series_url instead of an arbitrary cross-source one.
    """
    tk = r.get("title_key", "")
    s = r.get("source", "")
    rc = rc_map.get((tk, s)) or rc_map.get(tk, {})
    _wl_raw = r.get("series_url") or ""
    _wl_series = _wl_raw if str(_wl_raw).startswith(("http://", "https://")) else (rc.get("series_url") or "")
    # cover must be a real http(s) URL; scrapers/FE sometimes store 'x' or
    # other non-URL placeholders — fall through to recent_chapters cover.
    _wl_cover = r.get("cover")
    _cover = _wl_cover if str(_wl_cover or "").startswith(("http://", "https://")) else (rc.get("cover") or "")
    if _cover:
        _cover = scrub_cover(_cover)
    desc = r.get("description") or meta_desc.get(tk) or meta_desc.get(tk.replace(" ", "-")) or None
    if not desc and _wl_series:
        seg = _wl_series.rstrip("/").split("/")[-1]
        desc = meta_desc.get(seg) or None
    _meta_cov = meta_cover.get(tk) or meta_cover.get(" ".join(tk.split("-"))) or ""
    if _meta_cov:
        _meta_cov = scrub_cover(_meta_cov)
    return {
        "id": str(r.get("id") or f"{tk}:{s}" if s else tk),
        "title": html.unescape(r.get("title") or ""),
        "titleKey": tk,
        "canonicalTitleKey": normalize_title_key(tk),
        "cover": _cover or _meta_cov or "",
        "source": s,
        "sources": [s] if s else [],
        "sourceUrls": {s: (_wl_series or "")} if s else {},
        
        "rating": r.get("rating") or None,
        "type": r.get("type") or None,
        "origin": r.get("origin") or "",
        "genres": r.get("genres") or [],
        "description": desc,
        "seriesUrl": _wl_series,
        "url": _wl_series,
        "lastNotified": last_notified.get(tk) or None,
        "lastChapter": rc.get("updated_time") or None,
        "time": rc.get("updated_time") or None,
        "latestChapter": r.get("latest_chapter"),
        "latestSentChapter": r.get("latest_sent_chapter"),
        "createdAt": r.get("created_at") or None,
    }


def _canonical_of(tk: str) -> str:
    from app.storage.canonical import canonical_of as _co
    return _co(tk)


def fetch_whitelist_enrichment(sb, rows: list[dict], all_tks: list[str]):
    """Fetch rc/meta/dh maps for get_whitelist — isolated for testability."""
    rc_map: dict = {}
    meta_desc: dict[str, str] = {}
    meta_cover: dict[str, str] = {}
    last_notified: dict[str, str] = {}

    cand_keys: set[str] = set()
    for r in rows:
        tk = r.get("title_key", "")
        if tk:
            cand_keys.add(tk)
            cand_keys.add(tk.replace(" ", "-"))
        su = (r.get("series_url") or r.get("url") or "").rstrip("/").split("/")[-1]
        if su:
            cand_keys.add(su)

    def _q_recent():
        q = sb.table("recent_chapters").select("title_key, title, source, cover, origin, updated_time, series_url")
        if all_tks:
            q = q.in_("title_key", all_tks)
        return q.execute()

    def _q_meta():
        if not cand_keys:
            return None
        return sb.table("whitelist").select("title_key, description, cover").in_("title_key", list(cand_keys)).execute()

    def _q_dh():
        tks = [r.get("title_key", "") for r in rows if r.get("title_key")]
        if not tks:
            return None
        return sb.table("dispatch_history").select("title_key, sent_at").in_("title_key", tks).execute()

    rc_rows = _q_recent()
    meta_rows = _q_meta()
    dh_rows = _q_dh()

    if rc_rows and rc_rows.data:
        for rc in rc_rows.data:
            tk = rc.get("title_key")
            src = rc.get("source") or ""
            if tk and (tk, src) not in rc_map:
                rc_map[(tk, src)] = rc
    try:
        _meta_data = (meta_rows.data if (meta_rows and getattr(meta_rows, "data", None)) else [])
        for m in _meta_data:
            d = m.get("description")
            if d:
                meta_desc[m.get("title_key", "")] = d
            c = m.get("cover")
            if c:
                meta_cover[m.get("title_key", "")] = c
    except Exception:
        pass
    try:
        _dh_data = (dh_rows.data if (dh_rows and getattr(dh_rows, "data", None)) else [])
        for d in _dh_data:
            tk = d.get("title_key", "")
            ts = d.get("sent_at") or ""
            if tk and (tk not in last_notified or ts > last_notified[tk]):
                last_notified[tk] = ts
    except Exception:
        pass
    return rc_map, meta_desc, meta_cover, last_notified
