"""Whitelist dedup — cross-source merge by canonical title_key.

Extracted from whitelist_service.py to isolate the merge logic
(single responsibility, testable). Keeps the FCFS/canonical grouping
in one place; whitelist_service only orchestrates.
"""
from __future__ import annotations


def dedup_whitelist(mapped: list[dict], canonical_of) -> list[dict]:
    """Merge `mapped` rows that share the same canonical title_key.

    Args:
        mapped: rows already mapped via build_whitelist_mapped_row (each has titleKey, sources etc.)
        canonical_of: callable(titleKey) -> canonical key (from app.storage.canonical)
    """
    if not mapped:
        return []
    groups: dict[str, list[dict]] = {}
    for m in mapped:
        nk = canonical_of(m["titleKey"]) or m["titleKey"]
        groups.setdefault(nk, []).append(m)

    deduped: list[dict] = []
    for _nk, _items in groups.items():
        if len(_items) == 1:
            deduped.append(_items[0])
            continue
        _primary = _items[0]
        _sources: list[dict] = []
        _seen_src: set[str] = set()
        for _it in _items:
            for _s in _it.get("sources", []):
                if _s not in _seen_src:
                    _seen_src.add(_s)
                    _sources.append({"source": _s, "url": _it.get("series_url") or ""})
        _merged = dict(_primary)
        _merged["sources"] = [s["source"] for s in _sources]
        _merged["source"] = _sources[0]["source"] if _sources else (_primary.get("source") or "")
        _merged["source_detail"] = _sources
        for _fld in ("cover", "origin", "rating", "description", "type"):
            for _it in _items:
                if _it.get(_fld):
                    _merged[_fld] = _it[_fld]
                    break
        _genres: list[str] = []
        for _it in _items:
            for _g in (_it.get("genres") or []):
                if _g not in _genres:
                    _genres.append(_g)
        _merged["genres"] = _genres
        _merged["created_at"] = max([_it.get("created_at") or "" for _it in _items]) or _primary.get("created_at")
        for _fld in ("latest_chapter", "latest_sent_chapter"):
            _vals = [_it.get(_fld) for _it in _items if _it.get(_fld) is not None]
            _merged[_fld] = max(_vals) if _vals else None
        deduped.append(_merged)
    return deduped
