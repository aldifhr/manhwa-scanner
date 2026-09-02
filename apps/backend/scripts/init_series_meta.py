"""Create series_meta table and backfill from recent_chapters.

series_meta holds per-series STATIC data (rating, genres, description, cover,
author, type) keyed by (title_key, source). This is the single source of truth
for series-level fields that used to be duplicated across every chapter row in
recent_chapters. RSS joins to it; collect upserts into it.

Idempotent: CREATE TABLE IF NOT EXISTS, and the backfill only writes rows that
are missing or have empty values.
"""
from __future__ import annotations

import sys
from app.db import get_supabase
from app.utils.text import normalize_title_key

sb = get_supabase()

CREATE_SQL = """
CREATE TABLE IF NOT EXISTS series_meta (
    title_key   TEXT NOT NULL,
    source      TEXT NOT NULL,
    rating      TEXT,
    genres      JSONB,
    description TEXT,
    cover       TEXT,
    author      TEXT,
    type        TEXT,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (title_key, source)
);
"""

# Use a raw connection for DDL (adapter has no DDL helper).
from app.db_adapter import _get_pool  # type: ignore
conn = _get_pool().getconn()
try:
    cur = conn.cursor()
    cur.execute(CREATE_SQL)
    conn.commit()
    print("[init] series_meta table ready")
finally:
    _get_pool().putconn(conn)


def main() -> None:
    # Pull every (title_key, source) from recent_chapters with non-empty static data.
    # We aggregate per series: take the most complete row.
    rows = sb.table("recent_chapters").select(
        "title_key, source, rating, genres, description, cover, type"
    ).execute().data or []
    print(f"[backfill] scanned {len(rows)} recent_chapters rows")

    # Best-effort per (title_key, source): prefer populated fields.
    best: dict[tuple[str, str], dict] = {}
    for r in rows:
        tk = str(r.get("title_key") or "").strip()
        src = str(r.get("source") or "").strip()
        if not tk or not src:
            continue
        key = (tk, src)
        cur = best.get(key)
        if cur is None:
            cur = {"title_key": tk, "source": src, "rating": None, "genres": None,
                   "description": None, "cover": None, "type": None}
            best[key] = cur
        for f in ("rating", "genres", "description", "cover", "type"):
            v = r.get(f)
            if (v is not None) and (v != "") and (v != []) and (cur[f] in (None, "", [])):
                cur[f] = v

    print(f"[backfill] distinct series: {len(best)}")

    written = 0
    for key, row in best.items():
        # Skip series that have NO static data at all (pure upstream failures).
        if not (row.get("rating") or row.get("genres") or (row.get("description") or "").strip()):
            continue
        row["updated_at"] = "now()"
        try:
            sb.table("series_meta").upsert(
                row, on_conflict="title_key,source"
            ).execute()
            written += 1
        except Exception as e:  # noqa: BLE001
            print(f"[backfill] upsert failed {key}: {e}", file=sys.stderr)

    print(f"[backfill] wrote {written} series_meta rows")


if __name__ == "__main__":
    main()
