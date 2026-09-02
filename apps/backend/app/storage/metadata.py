"""Manga metadata storage — reads from whitelist (single source of truth)."""
from typing import Optional
from app.db import get_supabase
from app.logger import get_logger

logger = get_logger("storage:metadata")


def batch_get_manga_metadata(title_keys: list[str]) -> list[Optional[dict]]:
    """Get metadata from whitelist (cover/status/rating/genres/description)."""
    if not title_keys:
        return []
    try:
        res = (
            get_supabase()
            .table("whitelist")
            .select("title_key, cover, status, rating, genres, description, origin")
            .in_("title_key", title_keys)
            .execute()
        )
        rows = res.data or []
        by_key = {r["title_key"]: r for r in rows}
        return [by_key.get(tk) for tk in title_keys]
    except Exception as e:
        logger.error("batchGetMangaMetadata failed", exc=e)
        return []


def upsert_manga_metadata(rows: list[dict]) -> None:
    """Upsert metadata into whitelist."""
    if not rows:
        return
    try:
        get_supabase().table("whitelist").upsert(rows, on_conflict="title_key,source").execute()
    except Exception as e:
        logger.error("upsertMangaMetadata failed", exc=e)


def delete_manga_metadata(title_key: str) -> None:
    """No-op: whitelist is source of truth, no separate metadata table."""
