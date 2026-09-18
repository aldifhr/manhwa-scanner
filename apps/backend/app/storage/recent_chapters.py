"""Recent chapters storage — orchestration shell.

Pure SQL helpers (prune, batch insert, fetch, dedup) live in
recent_chapters_sql.py. This module re-exports them for backward
compatibility and owns the claim_recent_chapters_for_dispatch orchestrator.

Mutable module state (_wl_origins, _WL_ORIGIN_TS) is NOT re-exported —
it lives in the sql module and is mutated there via `global`. Tests that
poke it import recent_chapters_sql directly.
"""
from app.storage.recent_chapters_sql import *  # noqa: F401,F403 — re-export public SQL helpers
from app.storage.recent_chapters_sql import (
    _composite_key,
    _count_recent_rows,
    _fetch_recent_rows,
    _load_existing_rc,
    _norm_chapter_num,
    _row_to_item,
    batch_insert_recent_chapters,
    get_recent_chapters,
    get_recent_chapters_paginated,
    get_trending,
    invalidate_whitelist_origin_cache,
    prune_dispatch_history_older_than,
    prune_older_than,
)


def claim_recent_chapters_for_dispatch(
    whitelist: list[dict] | None = None, hours: int = 24, limit: int = 500
) -> list[dict]:
    """Delegates to services/claim.py (ponytail: 679L → 450L storage)."""
    from app.services.claim import claim_recent_chapters_for_dispatch as _impl

    return _impl(whitelist=whitelist, hours=hours, limit=limit)
