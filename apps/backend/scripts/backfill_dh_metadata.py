"""Backfill dispatch-history metadata gaps (BUG4 remainder).

Recent_chapters rows referenced by dispatch_history often lack genres/origin
because the series was last scraped before those fields were collected, or the
24h window pruned the rich row. We backfill from series_meta (genres/desc/
rating) and from sibling recent_chapters rows of the same (title_key, source).

Idempotent + safe.
"""
from __future__ import annotations
from app.db import get_supabase


def main():
    sb = get_supabase()

    # 1) series_meta lookup (title_key, source) -> genres/description/rating
    sm_rows = sb.table("series_meta").select("title_key, source, genres, description, rating").execute().data or []
    sm_map = {}
    for s in sm_rows:
        if s.get("title_key") and s.get("source"):
            sm_map[(s["title_key"], s["source"])] = s

    # 2) recent_chapters lookup (title_key, source) -> origin (any row)
    rc_rows = sb.table("recent_chapters").select("title_key, source, origin, genres").execute().data or []
    rc_origin: dict[tuple[str, str], str] = {}
    rc_genres: dict[tuple[str, str], list] = {}
    for r in rc_rows:
        tk = r.get("title_key") or ""
        src = r.get("source") or ""
        if not tk or not src:
            continue
        if r.get("origin"):
            rc_origin.setdefault((tk, src), r["origin"])
        if r.get("genres"):
            rc_genres.setdefault((tk, src), r["genres"])

    # 3) dispatch_history unique (title_key, source) needing fill
    dh_rows = sb.table("dispatch_history").select("title_key, source").execute().data or []
    needed = {(r["title_key"], r["source"]) for r in dh_rows if r.get("title_key") and r.get("source")}

    upd_genres = upd_origin = 0
    sm_inserts = 0
    for (tk, src) in needed:
        sm = sm_map.get((tk, src)) or {}
        _genres = sm.get("genres") or rc_genres.get((tk, src)) or []
        _origin = rc_origin.get((tk, src)) or ""
        if not _genres and not _origin:
            continue
        patch = {}
        if _genres:
            patch["genres"] = _genres
        if _origin:
            patch["origin"] = _origin
        if patch:
            sb.table("recent_chapters").update(patch).eq("title_key", tk).eq("source", src).execute()
            upd_genres += 1 if "genres" in patch else 0
            upd_origin += 1 if "origin" in patch else 0
        # Also ensure series_meta has this series (so service fallback works even
        # when recent_chapters is pruned).
        if _genres and (tk, src) not in sm_map:
            sb.table("series_meta").upsert({
                "title_key": tk,
                "source": src,
                "genres": _genres,
            }, on_conflict="title_key,source").execute()
            sm_inserts += 1

    print(f"series touched: {len(needed)}")
    print(f"backfilled genres to {upd_genres} (title_key,source) groups")
    print(f"backfilled origin to {upd_origin} (title_key,source) groups")
    print(f"inserted series_meta rows: {sm_inserts}")


if __name__ == "__main__":
    main()
