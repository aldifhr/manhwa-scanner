"""Chapter bookmarking — save reading position per chapter."""
from __future__ import annotations

from datetime import datetime, timezone

from app.logger import get_logger

logger = get_logger("bookmark")


def save_bookmark(
    title_key: str,
    chapter_number: float,
    chapter_url: str,
    session_hash: str,
    source: str = "",
    position_pct: float = 0.0,
    title: str = "",
    cover: str = "",
) -> dict:
    """Save a bookmark for a chapter."""
    try:
        from app.db import q
        q("""
            INSERT INTO chapter_bookmarks (title_key, chapter_number, chapter_url, session_hash, source, position_pct, title, cover, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (title_key, chapter_number, session_hash) DO UPDATE SET
                position_pct = EXCLUDED.position_pct,
                chapter_url = EXCLUDED.chapter_url,
                title = COALESCE(NULLIF(EXCLUDED.title,''), chapter_bookmarks.title),
                cover = COALESCE(NULLIF(EXCLUDED.cover,''), chapter_bookmarks.cover),
                updated_at = EXCLUDED.updated_at
        """, [
            title_key, chapter_number, chapter_url, session_hash, source,
            position_pct, title, cover, datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat()
        ])
        return {"status": "ok"}
    except Exception as e:
        logger.error("save_bookmark failed", exc=e)
        return {"status": "error", "error": str(e)[:200]}


def get_bookmarks(session_hash: str, limit: int = 100, offset: int = 0) -> list[dict]:
    """Get bookmarks for a session with pagination."""
    try:
        from app.db import q
        return q("""
            SELECT b.title_key, b.chapter_number, b.chapter_url, b.source, b.position_pct, b.updated_at,
                   COALESCE(NULLIF(b.title,''), w.title, b.title_key) as title,
                   COALESCE(NULLIF(b.cover,''), w.cover, rc.cover) as cover
            FROM chapter_bookmarks b
            LEFT JOIN whitelist w ON REPLACE(LOWER(w.title_key), '-', ' ') = REPLACE(LOWER(b.title_key), '-', ' ') AND w.source = b.source
            LEFT JOIN LATERAL (SELECT cover FROM recent_chapters rc WHERE REPLACE(LOWER(rc.title_key), '-', ' ') = REPLACE(LOWER(b.title_key), '-', ' ') ORDER BY updated_time DESC LIMIT 1) rc ON true
            WHERE b.session_hash = %s
            ORDER BY updated_at DESC
            LIMIT %s OFFSET %s
        """, [session_hash, limit, offset])
    except Exception as e:
        logger.error("get_bookmarks failed", exc=e)
        return []


def get_bookmark(title_key: str, chapter_number: float, session_hash: str) -> dict | None:
    """Get a specific bookmark."""
    try:
        from app.db import q
        result = q("""
            SELECT title_key, chapter_number, chapter_url, source, position_pct, updated_at
            FROM chapter_bookmarks
            WHERE title_key = %s AND chapter_number = %s AND session_hash = %s
            LIMIT 1
        """, [title_key, chapter_number, session_hash])
        return result[0] if result else None
    except Exception as e:
        logger.error("get_bookmark failed", exc=e)
        return None


def delete_bookmark(title_key: str, chapter_number: float, session_hash: str) -> dict:
    """Delete a bookmark."""
    try:
        from app.db import q
        q("""
            DELETE FROM chapter_bookmarks
            WHERE title_key = %s AND chapter_number = %s AND session_hash = %s
        """, [title_key, chapter_number, session_hash])
        return {"status": "ok"}
    except Exception as e:
        logger.error("delete_bookmark failed", exc=e)
        return {"status": "error", "error": str(e)[:200]}
