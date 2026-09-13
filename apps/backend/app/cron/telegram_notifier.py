"""Telegram notifier — sends chapter-release notifications via Bot API.

Configured via:
  TELEGRAM_BOT_TOKEN  — bot token from @BotFather
  TELEGRAM_CHAT_ID    — target chat/channel ID (e.g. -1001234567890)

No-op if either is unset. Fire-and-forget, never raises.
"""
from __future__ import annotations

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.logger import get_logger

logger = get_logger("telegram")


def _send_photo(photo_url: str, caption: str) -> None:
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "") or ""
    chat_id = getattr(settings, "TELEGRAM_CHAT_ID", "") or ""
    if not token or not chat_id:
        return
    body = json.dumps({
        "chat_id": chat_id,
        "photo": photo_url,
        "caption": caption,
        "parse_mode": "HTML",
    }).encode()
    url = f"https://api.telegram.org/bot{token}/sendPhoto"
    try:
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json", "User-Agent": "manhwa-backend/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status >= 300:
                logger.warn("telegram photo non-2xx", status=r.status)
    except Exception as e:
        logger.warn("telegram photo failed", err=str(e)[:120])


def _send_text(text: str) -> None:
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "") or ""
    chat_id = getattr(settings, "TELEGRAM_CHAT_ID", "") or ""
    if not token or not chat_id:
        return
    body = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode()
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json", "User-Agent": "manhwa-backend/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status >= 300:
                logger.warn("telegram text non-2xx", status=r.status)
    except Exception as e:
        logger.warn("telegram text failed", err=str(e)[:120])


def _fmt_rating(rating) -> str:
    try:
        r = float(rating)
        if r <= 0:
            return ""
        return f"⭐ {r:.1f}"
    except (ValueError, TypeError):
        return ""


def _fmt_genres(genres) -> str:
    if not genres or not isinstance(genres, list):
        return ""
    return ", ".join(str(g) for g in genres[:6])


def notify_chapter(item: dict) -> None:
    """Send chapter-release notification with cover + rich formatting."""
    title = item.get("title", "Unknown")
    chapter = item.get("chapter", "?")
    source = item.get("source", "?")
    origin = item.get("origin", "")
    series_url = item.get("series_url", "")
    chapter_url = item.get("chapter_url", "")
    cover = item.get("cover") or ""
    rating = _fmt_rating(item.get("rating"))
    genres = _fmt_genres(item.get("genres"))
    description = (item.get("description") or "").strip()
    updated_time = item.get("updated_time", "")

    origin_tag = f" [{origin}]" if origin else ""

    # Build caption matching Discord embed fields
    parts = [f"📖 <b>{title}</b>{origin_tag}", ""]
    meta_line = f"Chapter {chapter} · {source}"
    if rating:
        meta_line += f" · {rating}"
    parts.append(meta_line)
    if genres:
        parts.append(f"🏷 {genres}")
    if description:
        short = description[:200] + ("…" if len(description) > 200 else "")
        parts.append(f"📝 {short}")
    parts.append("")
    if chapter_url:
        parts.append(f"🔗 <a href=\"{chapter_url}\">Read Chapter</a>")
    if series_url and series_url != chapter_url:
        parts.append(f"📚 <a href=\"{series_url}\">Series Page</a>")
    if updated_time:
        parts.append(f"⏰ {updated_time}")

    caption = "\n".join(parts)

    # Trim caption to 1024 chars (Telegram photo caption limit)
    if len(caption) > 1020:
        caption = caption[:1017] + "…"

    with ThreadPoolExecutor(max_workers=1) as ex:
        if cover:
            ex.submit(_send_photo, cover, caption)
        else:
            ex.submit(_send_text, caption)


def notify_text(text: str) -> None:
    """Send plain text alert (gap, source health, etc.)."""
    with ThreadPoolExecutor(max_workers=1) as ex:
        ex.submit(_send_text, text)
