"""Migrate whitelist: collapse cross-source duplicate title_key rows.

Whitelist has 107 rows but only ~82 distinct title_key values — the same
logical title (e.g. "top star sent by god") is stored once per source
(ikiru/voratoon/shinigami) with an identical title_key. We keep ONE row per
title_key (the most-complete / latest) and delete the rest.

dispatch_history.key the SAME title_key, so no history rewrite is needed.
excluded_titles is empty (verified), so nothing else references these rows.

Safe: prints planned deletes, then executes. Idempotent (re-running finds
no duplicates).
"""
from __future__ import annotations
from collections import defaultdict
from app.db import get_supabase


def _score(r: dict) -> int:
    """Higher = more complete; prefer this row as the survivor."""
    s = 0
    for f in ("series_url", "cover", "rating", "genres", "description", "type", "origin"):
        v = r.get(f)
        if v is None:
            continue
        if isinstance(v, (list, dict)) and len(v) == 0:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        s += 1
    return s


def main():
    sb = get_supabase()
    rows = sb.table("whitelist").select("*").execute().data or []
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[r.get("title_key", "")].append(r)

    to_delete = []
    kept = 0
    for tk, items in groups.items():
        if len(items) <= 1:
            kept += 1
            continue
        # Survivor = most complete; tie-break = latest created_at
        survivor = max(
            items,
            key=lambda r: (_score(r), str(r.get("created_at") or "")),
        )
        for r in items:
            if r["id"] != survivor["id"]:
                to_delete.append(r["id"])
        kept += 1

    print(f"distinct title_key: {kept}")
    print(f"rows before: {len(rows)} | to delete: {len(to_delete)} | rows after: {kept}")

    if not to_delete:
        print("nothing to do")
        return

    # Delete in batches
    for i in range(0, len(to_delete), 50):
        batch = to_delete[i : i + 50]
        sb.table("whitelist").delete().in_("id", batch).execute()
    print(f"deleted {len(to_delete)} duplicate rows")

    # Verify
    after = sb.table("whitelist").select("id", count="exact").execute().count
    print(f"rows after: {after}")


if __name__ == "__main__":
    main()
