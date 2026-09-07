"""RSS query helpers — filtering, result mapping, and grouping."""
from __future__ import annotations

import html
import re

from app.utils.text import normalize_title_key
from app.utils.origin import normalize_origin
from app.utils.cover_scrub import scrub_cover
from app.config import settings


def normalize_type(raw) -> str | None:
    if not raw:
        return None
    t = str(raw).strip().lower()
    if t in ("manhwa", "manhua", "manga"):
        return t
    if t.startswith("manh"):
        return "manhwa" if t.endswith("wa") else "manhua"
    return t or None


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug_key(tk: str) -> str:
    t = normalize_title_key(tk).lower()
    return _SLUG_RE.sub("-", t).strip("-")


def _canonical(tk: str) -> str:
    from app.storage.canonical import canonical_of as _co
    return _co(tk)


def _is_sent(it: dict, tk: str, src: str, dh_sent: set[tuple[str, float]] | None) -> bool:
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
    def _passes(it: dict) -> bool:
        src = it.get("source", "")
        o = (it.get("origin") or "").upper()
        tk = str(it.get("title_key", "") or "").strip()
        if source_f and src != source_f:
            return False
        if origin_f and o != origin_f.upper():
            return False
        if exclude and o in [e.strip().upper() for e in exclude.split(",") if e.strip()]:
            return False
        if q and q.lower() not in (it.get("title") or "").lower():
            return False
        if exclude_origin and o in [e.strip().upper() for e in exclude_origin.split(",") if e.strip()]:
            return False
        if excl_keys and tk:
            if (tk, src) in excl_keys:
                return False
            if (tk, "all") in excl_keys:
                return False
        if type_f and (it.get("type") or "").lower() != type_f.lower():
            return False
        return True
    return _passes


def map_result(
    it: dict,
    wl_map: dict[tuple[str, str], dict],
    sm_map: dict[tuple[str, str], dict] | None = None,
    dh_sent: set[tuple[str, float]] | None = None,
    wl_title_set: set[str] | None = None,
) -> dict:
    """Map a recent_chapters row to RSS response. Uses it + wl + sm only.

    ponytail: series_meta canonical single source for static fields — sm>it>wl priority, whitelist minimal (title_key,source,series_url,latest_sent) legacy fields only fallback
    """
    # ponytail: single scrub, sm is sole static source; no per-slug refetch, no live HTTP fallback — add DB view/join if misses grow
    if sm_map is None:
        sm_map = {}
    tk = it.get("title_key", "")
    src = it.get("source", "")
    nk = normalize_title_key(tk)
    wl = wl_map.get((tk, src)) or wl_map.get((nk, src), {}) or {}
    sm = sm_map.get((tk, src)) or sm_map.get((nk, src), {}) or {}

    is_wl = (tk, src) in wl_map or (nk, src) in wl_map
    _title_norm = normalize_title_key(it.get("title") or "")
    if _title_norm and src in ("ikiru", "voratoon") and not is_wl:
        if wl_title_set is not None:
            if _title_norm in wl_title_set:
                for (wtk, wsrc) in wl_map:
                    if wsrc in ("ikiru", "voratoon") and normalize_title_key(wtk) == _title_norm:
                        is_wl = True
                        break
        else:
            for (wtk, wsrc), wrow in wl_map.items():
                if wsrc not in ("ikiru", "voratoon"):
                    continue
                if normalize_title_key(wrow.get("title") or wtk) == _title_norm:
                    is_wl = True
                    break

    series_url = it.get("series_url") or wl.get("series_url") or sm.get("series_url") or ""
    cover = scrub_cover(it.get("cover") or wl.get("cover") or sm.get("cover") or "")

    ls = wl.get("latest_sent_chapter")

    chapter_url = it.get("chapter_url") or ""
    if chapter_url == "?chapter" or (chapter_url.startswith(f"{settings.IKIRU_BASE_URL.rstrip(chr(47))}/") and "/chapter-" not in chapter_url and "?" in chapter_url):
        series_url_rc = it.get("series_url") or ""
        ch_num = it.get("chapter") or ""
        cid = it.get("chapter_id") or ""
        if series_url_rc and ch_num:
            slug = series_url_rc.rstrip("/").split("/")[-1]
            if slug and slug != "manga":
                chapter_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/chapter-{ch_num}.{cid}/" if cid else f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{slug}/chapter-{ch_num}/"
            else:
                chapter_url = f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{series_url_rc.split('/')[-2] if '/' in series_url_rc else ''}/chapter-{ch_num}.{cid}/" if cid else f"{settings.IKIRU_BASE_URL.rstrip('/')}/manga/{series_url_rc.split('/')[-2] if '/' in series_url_rc else ''}/chapter-{ch_num}/"
        else:
            chapter_url = ""

    _raw_title = it.get("title", "") or ""
    _title = html.unescape(_raw_title) if _raw_title else ""
    _genres_raw = sm.get("genres") or it.get("genres") or wl.get("genres") or []
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

    def _to_num(v):
        if v is None or v == "":
            return None
        try:
            return float(v)
        except (ValueError, TypeError):
            return None

    # ponytail: canonical sm > it > wl — sm is single source, wl/it only legacy fallback; add DB view if richer joins needed
    _rating = _to_num(sm.get("rating")) if sm.get("rating") not in (None, "") else (
        _to_num(it.get("rating")) if it.get("rating") is not None else _to_num(wl.get("rating"))
    )
    _type = normalize_type(sm.get("type") or it.get("type") or wl.get("type") or None)
    _raw_origin = it.get("origin") or wl.get("origin") or sm.get("origin") or ""
    origin = normalize_origin(_raw_origin)

    _raw_chapter_num = it.get("chapter_num")
    try:
        _chapter_num_f = float(_raw_chapter_num) if _raw_chapter_num is not None else 0.0
    except (ValueError, TypeError):
        _chapter_num_f = 0.0
    slug = _slug_key(tk)
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
        "description": sm.get("description") or it.get("description") or wl.get("description") or "",
        "isWhitelisted": is_wl,
        "chapter": it.get("chapter"),
        "chapterLabel": chapter_label(str(it.get("chapter") or "")),
        "chapterNumber": chapter_number(str(it.get("chapter") or "")),
        "chapterUrl": chapter_url,
        "sentAt": it.get("updated_time") or it.get("created_at"),
        "isSent": _is_sent(it, tk, src, dh_sent),
        "lastCheckedChapter": _chapter_num_f,
        "latestSentChapter": float(ls) if ls else None,
        "latestChapter": _chapter_num_f,
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
