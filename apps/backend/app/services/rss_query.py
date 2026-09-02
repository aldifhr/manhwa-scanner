"""RSS query helpers — filtering, result mapping, and grouping.

Extracted from app/api/rss.py to separate data-transformation logic
from the HTTP request handler.
"""
from __future__ import annotations

import html
import re
import time as _time

from app.utils.text import normalize_title_key
from app.utils.origin import normalize_origin
from app.utils.cover_scrub import scrub_cover
from app.config import settings


def normalize_type(raw) -> str | None:
    """Canonicalize a series type string to manhwa/manhua/manga (lowercase)."""
    if not raw:
        return None
    t = str(raw).strip().lower()
    if t in ("manhwa", "manhua", "manga"):
        return t
    # tolerate 'Manhwa', 'MANHWA', etc.
    if t.startswith("manh"):
        return "manhwa" if t.endswith("wa") else "manhua"
    if t == "manga":
        return "manga"
    return t or None

# Live fallback cache for series meta when DB has no entry.
_RSS_LIVE_META_CACHE: dict[str, tuple[float, dict]] = {}
_RSS_LIVE_META_TTL = 3600.0
_RSS_LIVE_META_MAX = 256

_LABEL_RE = re.compile(r"^\s*(?:ch(?:apter)?\.?\s*|chapter\s*)[:.]?\s*(.+)$", re.I)
_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)")
_SLUG_RE = re.compile(r"[^a-z0-9]+")
_GROUP_RE = re.compile(r"\s+")


def _slug_key(tk: str) -> str:
    t = normalize_title_key(tk).lower()
    return _SLUG_RE.sub("-", t).strip("-")


def _canonical(tk: str) -> str:
    from app.storage.canonical import canonical_of as _co
    return _co(tk)


def _is_sent(it: dict, tk: str, src: str, dh_sent: set[tuple[str, float]] | None) -> bool:
    """A chapter is 'sent' iff (title_key, chapter_num) is in dispatch_history.

    BUG3: previously isSent was inferred from whitelist.latest_sent_chapter,
    which drifted out of sync with actual dispatches. Dispatch is per-release
    (any source), so we match on (title_key, chapter_num) only.
    """
    if not dh_sent:
        return False
    _cn_raw = it.get("chapter_num")
    try:
        cn = float(_cn_raw) if _cn_raw is not None else None
    except (ValueError, TypeError):
        cn = None
    if cn is None:
        cn = chapter_number(str(it.get("chapter") or ""))
    if cn is None:
        return False
    nk = normalize_title_key(tk)
    return (tk, cn) in dh_sent or (nk, cn) in dh_sent


def chapter_label(ch: str) -> str:
    ch = (ch or "").strip()
    if not ch:
        return ""
    m = re.match(r"^\s*(?:ch(?:apter)?\.?\s*|chapter\s*)[:.]?\s*(.+)$", ch, re.I)
    if m:
        inner = m.group(1).strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", inner):
            return f"Chapter {inner}"
        num = re.match(r"(\d+(?:\.\d+)?)", inner)
        if num:
            rest = inner[num.end():].strip(" -–—:")
            return f"Chapter {num.group(1)}" + (f" - {rest}" if rest else "")
        return f"Chapter {inner}"
    num = re.match(r"^(\d+(?:\.\d+)?)\s*(.*)$", ch)
    if num and (not num.group(2) or num.group(2).lower().startswith(("side", "extra", "special", "ss"))):
        rest = num.group(2).strip()
        return f"Chapter {num.group(1)}" + (f" - {rest}" if rest else "")
    return ch


def chapter_number(ch: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)", ch or "")
    return float(m.group(1)) if m else None


def group_key(value: str) -> str:
    key = normalize_title_key(value or "")
    for art in ("the ", "a ", "an "):
        if key.startswith(art):
            key = key[len(art):]
            break
    return key


def build_filter(
    source_f: str = "",
    origin_f: str = "",
    exclude: str = "",
    q: str = "",
    exclude_origin: str = "",
    excl_keys: set[tuple[str, str]] | None = None,
    type_f: str = "",
) -> callable:
    """Build a filter function from RSS query parameters."""
    def _passes(it: dict) -> bool:
        src = it.get("source", "")
        o = (it.get("origin") or "").upper()
        tk = str(it.get("title_key", "") or "").strip()
        if source_f and src != source_f:
            return False
        if origin_f and o != origin_f.upper():
            return False
        if exclude:
            if o in [e.strip().upper() for e in exclude.split(",") if e.strip()]:
                return False
        if q and q.lower() not in (it.get("title") or "").lower():
            return False
        if exclude_origin:
            if o in [e.strip().upper() for e in exclude_origin.split(",") if e.strip()]:
                return False
        if excl_keys and tk:
            if (tk, src) in excl_keys:
                return False
            if (tk, "all") in excl_keys:
                return False
        # Type filter (manhwa/manhua/manga)
        if type_f:
            it_type = (it.get("type") or "").lower()
            if it_type != type_f.lower():
                return False
        return True
    return _passes


def map_result(
    it: dict,
    wl_map: dict[tuple[str, str], dict],
    meta_map: dict[str, dict],
    live_cnt_ref: list[int],
    sm_map: dict[tuple[str, str], dict] | None = None,
    dh_sent: set[tuple[str, float]] | None = None,
) -> dict:
    """Map a recent_chapters row to the RSS response format.

    `sm_map` is the per-series static metadata lookup (title_key, source) →
    series_meta row. It is the single source of truth for rating/description/
    genres/cover/type; recent_chapters columns are only used as a fallback
    for rows belonging to a series not yet present in series_meta.
    """
    if sm_map is None:
        sm_map = {}
    tk = it.get("title_key", "")
    src = it.get("source", "")
    nk = normalize_title_key(tk)
    wl = wl_map.get((tk, src)) or wl_map.get((nk, src), {}) or {}
    sm = sm_map.get((tk, src)) or sm_map.get((nk, src), {}) or {}
    slug = _slug_key(tk)

    is_wl = (tk, src) in wl_map or (nk, src) in wl_map

    series_url = it.get("series_url") or wl.get("series_url") or ""
    _meta_slug = (series_url or it.get("series_url") or "").rstrip("/").split("/")[-1] if series_url else ""
    _meta = meta_map.get(_meta_slug) or {}

    # Live fallback: fetch from upstream if DB has no meta
    if not _meta and _meta_slug and src in ("shinigami", "ikiru"):
        _cached_live = _RSS_LIVE_META_CACHE.get(_meta_slug)
        if _cached_live and (_time.monotonic() - _cached_live[0]) < _RSS_LIVE_META_TTL:
            _meta = _cached_live[1]
        else:
            if live_cnt_ref[0] < 8:
                try:
                    _fetched = None
                    if src == "shinigami":
                        from app.scrapers import shinigami as _sh
                        _fetched = _sh.get_shinigami_series_meta(_meta_slug)
                    elif src == "ikiru":
                        from app.scrapers import ikiru as _ik
                        _fetched = _ik.get_ikiru_series_meta(_meta_slug)
                    if _fetched:
                        _meta = _fetched
                        _RSS_LIVE_META_CACHE[_meta_slug] = (_time.monotonic(), _meta)
                        if len(_RSS_LIVE_META_CACHE) > _RSS_LIVE_META_MAX:
                            oldest = sorted(_RSS_LIVE_META_CACHE.items(), key=lambda kv: kv[1][0])[:32]
                            for k, _ in oldest:
                                _RSS_LIVE_META_CACHE.pop(k, None)
                        live_cnt_ref[0] += 1
                except Exception:
                    pass

    cover = scrub_cover(it.get("cover") or wl.get("cover") or _meta.get("cover") or "")
    origin = normalize_origin(it.get("origin") or wl.get("origin") or _meta.get("origin") or "")
    if not series_url:
        series_url = _meta.get("series_url") or ""

    ls = wl.get("latest_sent_chapter")

    # Fix broken ikiru chapter URLs (e.g. "?chapter" without slug)
    chapter_url = it.get("chapter_url", "")
    if chapter_url == "?chapter" or (chapter_url.startswith(f"{settings.IKIRU_BASE_URL.rstrip(chr(47))}/") and "/chapter-" not in chapter_url and "?" in chapter_url):
        # Reconstruct from series_url + chapter info
        series_url = it.get("series_url") or ""
        ch_num = it.get("chapter") or ""
        cid = it.get("chapter_id") or ""
        if series_url and ch_num:
            # Extract slug from series_url
            slug = series_url.rstrip("/").split("/")[-1]
            if slug and slug != "manga":
                chapter_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/chapter-{ch_num}.{cid}/" if cid else f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/chapter-{ch_num}/"
            else:
                chapter_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{series_url.split('/')[-2] if '/' in series_url else ''}/chapter-{ch_num}.{cid}/" if cid else f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{series_url.split('/')[-2] if '/' in series_url else ''}/chapter-{ch_num}/"
        else:
            chapter_url = ""

    # --- Field normalization (BUG2) ---
    _raw_title = it.get("title", "") or ""
    _title = html.unescape(_raw_title) if _raw_title else ""
    # genres: unique + lowercase
    _genres_raw = sm.get("genres") or it.get("genres") or wl.get("genres") or _meta.get("genres") or []
    _genres_seen: set[str] = set()
    _genres: list[str] = []
    if isinstance(_genres_raw, list):
        for g in _genres_raw:
            if not isinstance(g, str):
                continue
            _gl = g.strip().lower()
            if _gl and _gl not in _genres_seen:
                _genres_seen.add(_gl)
                _genres.append(g.strip())
    # rating: standardize to number | null
    def _to_num(v):
        if v is None or v == "":
            return None
        try:
            return float(v)
        except (ValueError, TypeError):
            return None
    _rating = _to_num(sm.get("rating")) if sm.get("rating") not in (None, "") else (
        _to_num(it.get("rating")) if it.get("rating") is not None else (
            _to_num(wl.get("rating")) if wl.get("rating") is not None else _to_num(_meta.get("rating"))
        )
    )
    _type = normalize_type(sm.get("type") or it.get("type") or wl.get("type") or _meta.get("type") or None)

    return {
        "id": slug,
        "title": _title,
        "titleKey": slug,
        "canonicalTitleKey": _canonical(tk),
        "source": src,
        "sources": [src] if src else [],
        "cover": cover,
        "seriesUrl": series_url,
        "url": series_url,
        "origin": origin,
        "rating": _rating,
        "genres": _genres,
        "type": _type,
        "description": sm.get("description") or it.get("description") or wl.get("description") or _meta.get("description") or "",
        "isWhitelisted": is_wl,
        "chapter": it.get("chapter"),
        "chapterLabel": chapter_label(str(it.get("chapter") or "")),
        "chapterNumber": chapter_number(str(it.get("chapter") or "")),
        "chapterUrl": chapter_url,
        "sentAt": it.get("updated_time") or it.get("created_at"),
        "isSent": _is_sent(it, tk, src, dh_sent),
        "lastCheckedChapter": float(it.get("chapter_num") or 0),
        "latestSentChapter": float(ls) if ls else None,
        "latestChapter": float(it.get("chapter_num") or 0),
        "createdAt": it.get("updated_time") or it.get("created_at"),
    }


def group_results(results: list[dict]) -> list[dict]:
    """Group RSS results by canonicalTitleKey with chapter sub-lists."""
    groups: dict[str, dict] = {}
    for r in results:
        gk_raw = r.get("canonicalTitleKey") or r.get("titleKey") or r.get("title") or ""
        gk = group_key(gk_raw)
        if gk not in groups:
            groups[gk] = {
                "title": r["title"],
                "titleKey": r["titleKey"],
                "canonicalTitleKey": r["canonicalTitleKey"],
                "source": r["source"],
                "sources": list(r["sources"] or []),
                "cover": r["cover"],
                "seriesUrl": r["seriesUrl"],
                "url": r["url"],
                "origin": r["origin"],
                "type": r.get("type"),
                "rating": r["rating"],
                "genres": r["genres"],
                "description": r["description"],
                "isWhitelisted": r["isWhitelisted"],
                "lastCheckedChapter": r["lastCheckedChapter"],
                "latestSentChapter": r["latestSentChapter"],
                "latestChapter": r["latestChapter"],
                "chapters": [],
            }
        else:
            cur = groups[gk]
            cur["isWhitelisted"] = cur["isWhitelisted"] or r["isWhitelisted"]
            for s in r.get("sources") or []:
                if s not in cur["sources"]:
                    cur["sources"].append(s)
            if not cur.get("cover") and r.get("cover"):
                cur["cover"] = r["cover"]
            if not cur.get("seriesUrl") and r.get("seriesUrl"):
                cur["seriesUrl"] = r["seriesUrl"]
                cur["url"] = r["url"]
            if cur.get("rating") is None and r.get("rating") is not None:
                cur["rating"] = r["rating"]
            if not cur.get("genres") and r.get("genres"):
                cur["genres"] = r["genres"]
            if not cur.get("type") and r.get("type"):
                cur["type"] = r["type"]
            try:
                if float(r.get("lastCheckedChapter") or 0) > float(cur.get("lastCheckedChapter") or 0):
                    cur["lastCheckedChapter"] = r["lastCheckedChapter"]
            except Exception:
                pass
            try:
                if r.get("latestSentChapter") is not None and (cur.get("latestSentChapter") is None or float(r["latestSentChapter"]) > float(cur["latestSentChapter"] or 0)):
                    cur["latestSentChapter"] = r["latestSentChapter"]
            except Exception:
                pass
            try:
                if float(r.get("latestChapter") or 0) > float(cur.get("latestChapter") or 0):
                    cur["latestChapter"] = r["latestChapter"]
            except Exception:
                pass
        groups[gk]["chapters"].append({
            "chapterLabel": r["chapterLabel"],
            "chapterNumber": r["chapterNumber"],
            "url": r["chapterUrl"],
            "source": r["source"],
            "sentAt": r["sentAt"],
            "createdAt": r.get("createdAt") or r.get("sentAt"),
            "isSent": r["isSent"],
        })
    for g in groups.values():
        g["chapters"].sort(key=lambda c: c.get("chapterNumber") or 0, reverse=True)
    return list(groups.values())
