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


def _send(text: str) -> None:
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
                logger.warn("telegram non-2xx", status=r.status)
    except Exception as e:
        logger.warn("telegram send failed", err=str(e)[:120])


def notify_chapter(item: dict) -> None:
    """Send chapter-release notification. No-op if not configured."""
    title = item.get("title", "Unknown")
    chapter = item.get("chapter", "?")
    source = item.get("source", "?")
    origin = item.get("origin", "")
    series_url = item.get("series_url", "")
    origin_tag = f" [{origin}]" if origin else ""
    text = (
        f"📖 <b>{title}</b>{origin_tag}\n"
        f"Chapter {chapter} · {source}\n"
        f"<a href=\"{series_url}\">Read</a>"
    )
    with ThreadPoolExecutor(max_workers=1) as ex:
        ex.submit(_send, text)


def notify_text(text: str) -> None:
    """Send plain text alert (gap, source health, etc.)."""
    with ThreadPoolExecutor(max_workers=1) as ex:
        ex.submit(_send, text)
