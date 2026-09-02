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
) -> dict:
    """Save a bookmark for a chapter."""
    try:
        from app.db import q
        q("""
            INSERT INTO chapter_bookmarks (title_key, chapter_number, chapter_url, session_hash, source, position_pct, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (title_key, chapter_number, session_hash) DO UPDATE SET
                position_pct = EXCLUDED.position_pct,
                chapter_url = EXCLUDED.chapter_url,
                updated_at = EXCLUDED.updated_at
        """, [
            title_key, chapter_number, chapter_url, session_hash, source,
            position_pct, datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat()
        ])
        return {"status": "ok"}
    except Exception as e:
        logger.error("save_bookmark failed", exc=e)
        return {"status": "error", "error": str(e)[:200]}


def get_bookmarks(session_hash: str, limit: int = 100) -> list[dict]:
    """Get all bookmarks for a session."""
    try:
        from app.db import q
        return q("""
            SELECT title_key, chapter_number, chapter_url, source, position_pct, updated_at
            FROM chapter_bookmarks
            WHERE session_hash = %s
            ORDER BY updated_at DESC
            LIMIT %s
        """, [session_hash, limit])
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
