"""Separate, low-frequency cron that re-enriches recent_chapters metadata.

Why this exists (decoupled from the per-10-min chapter fetch):
- The rss-fetch pipeline scrapes new chapters + inserts them. Running the
  full per-series enrich (rating/status/genres/description via source APIs)
  inside that hot path is what made ikiru's run ~100s and occasionally blow
  the _SOURCE_TIMEOUT budget.
- Collect now already carries rating/cover/description from the list response,
  so the fetch path is fast (~30s) WITHOUT hitting the source APIs.
- This job runs on its own schedule (e.g. every 15-30 min via FastCron action
  "enrich") and patiently re-enriches every recent_chapters row in the 24h
  window: it fills status + genres (and refreshes rating/description/cover)
  from series_meta / source APIs, with a polite inter-fetch delay so we stay
  under shinigami 429 / ikiru Cloudflare 403 thresholds. No timeout pressure.

It is idempotent: re-running only refreshes rows, never duplicates.

This mirrors the design of series_meta_sync.py (static series metadata) but
operates on the recent_chapters feed rows directly so the Discord/RSS embed
shows complete metadata without blocking the scrape.
"""
from __future__ import annotations

import sys
import time

from app.db import get_supabase
from app.logger import get_logger
from app.storage import recent_chapters as rc_store

logger = get_logger("cron:enrich-resync")

# Patience: not on the hot path, so a slow polite cadence is fine.
_INTER_FETCH_DELAY = 0.5
_WINDOW_HOURS = 24


def enrich_recent_chapters(limit: int = 2000) -> dict:
    """Re-enrich every recent_chapters row in the 24h window.

    Reads rows, runs the shared enrich() (which fills gaps from series_meta /
    source APIs + persists to cache), then upserts the meta columns back to
    recent_chapters. Returns a stats dict for logging. Safe to run repeatedly.
    """
    from app.cron import enrich as enrich_mod

    sb = get_supabase()
    start = time.time()

    try:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=_WINDOW_HOURS)).isoformat()
        rows = (
            sb.table("recent_chapters")
            .select("*")
            .gte("updated_time", cutoff)
            .limit(limit)
            .execute()
            .data
            or []
        )
    except Exception as e:
        logger.error("enrich_resync: list failed", exc=e)
        return {"ok": False, "error": str(e)[:160]}

    if not rows:
        return {"ok": True, "updated": 0, "failed": 0, "duration": 0.0, "note": "no rows in window"}

    # Map DB rows -> item dicts enrich() understands.
    items = [rc_store._row_to_item(r) for r in rows]
    try:
        enriched = enrich_mod.enrich(items, persist_cache=True, skip_api=False)
    except Exception as e:
        logger.error("enrich_resync: enrich failed", exc=e)
        return {"ok": False, "error": str(e)[:160]}

    # Upsert only the meta columns back, keyed by chapter_url (unique per row).
    # NOTE: use raw psycopg2 UPDATE, NOT the Supabase upsert — the db_adapter
    # turns a partial-column upsert dict into a full-row INSERT, which violates
    # NOT-NULL constraints on title_key/chapter/ etc. A targeted UPDATE only
    # touches the meta columns and is safe.
    # CRITICAL: only SET a column when enrich produced a non-empty value —
    # enrich() returns '' for fields it couldn't fill (e.g. status for sources
    # whose list response has no status), and a blind UPDATE would OVERWRITE a
    # previously-good value with ''. We preserve existing values by skipping
    # empty ones.
    from app.db import get_conn, put_conn
    import json as _json
    conn = get_conn()
    cur = conn.cursor()
    updated = 0
    failed = 0
    for it in enriched:
        cu = it.get("chapter_url")
        if not cu:
            failed += 1
            continue
        _sets: list[str] = []
        _vals: list = []
        _rating = it.get("rating")
        if _rating not in (None, 0):
            _sets.append("rating=%s"); _vals.append(float(_rating))
        _cover = it.get("cover")
        if _cover:
            _sets.append("cover=%s"); _vals.append(str(_cover))
        _genres = it.get("genres")
        if _genres:
            _sets.append("genres=%s"); _vals.append(_json.dumps(_genres))
        _desc = it.get("description")
        if _desc:
            _sets.append("description=%s"); _vals.append(str(_desc))
        _origin = it.get("origin")
        if _origin:
            _sets.append("origin=%s"); _vals.append(str(_origin))
        if not _sets:
            # Nothing to update for this row — skip (don't clobber).
            continue
        try:
            cur.execute(
                f"UPDATE recent_chapters SET {', '.join(_sets)} WHERE chapter_url=%s",
                tuple(_vals) + (cu,),
            )
            updated += 1
        except Exception as e:
            logger.warn("enrich_resync: update failed", cu=cu[:60], err=str(e)[:120])
            failed += 1
        time.sleep(_INTER_FETCH_DELAY)
    try:
        conn.commit()
    except Exception as e:
        logger.warn("enrich_resync: commit failed", err=str(e)[:120])
    put_conn(conn)

    duration = round(time.time() - start, 1)
    stats = {
        "ok": True,
        "rows_in_window": len(rows),
        "updated": updated,
        "failed": failed,
        "duration": duration,
    }
    logger.info("enrich resync done", **stats)
    return stats


if __name__ == "__main__":
    import os
    os.environ.setdefault("PYTHONPATH", ".")
    res = enrich_recent_chapters()
    print(res, file=sys.stderr)
