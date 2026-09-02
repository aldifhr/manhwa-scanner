"""Outgoing webhook — POST chapter-release events to external URLs.

Configured via OUTBOUND_WEBHOOK_URLS (comma-separated) in .env. Each release
dispatched to Discord also fires a JSON payload to every configured URL.
Failures are logged and never block the dispatch path.

Payload:
{
  "event": "chapter_released",
  "title": "...", "title_key": "...", "chapter": "145", "chapter_number": 145.0,
  "url": "https://...", "series_url": "...", "source": "ikiru",
  "cover": "...", "origin": "KR", "type": "manhwa", "sent_at": "<iso>"
}
"""
from __future__ import annotations

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.logger import get_logger

logger = get_logger("outbound-webhook")


def _urls() -> list[str]:
    raw = getattr(settings, "OUTBOUND_WEBHOOK_URLS", "") or ""
    return [u.strip() for u in raw.split(",") if u.strip().startswith("http")]


def fire_chapter_released(item: dict, sent_at: str | None = None) -> None:
    """Fire-and-forget POST for one dispatched chapter. Safe to call from the
    dispatch loop — spawns a daemon thread per URL, never raises."""
    urls = _urls()
    if not urls or not item.get("url"):
        return
    from datetime import datetime, timezone
    payload = {
        "event": "chapter_released",
        "title": item.get("title"),
        "title_key": item.get("title_key"),
        "chapter": str(item.get("chapter") or ""),
        "chapter_number": _to_num(item.get("chapter_num")),
        "url": item.get("url"),
        "series_url": item.get("series_url"),
        "source": item.get("source"),
        "cover": item.get("cover"),
        "origin": item.get("origin"),
        "type": item.get("type"),
        "sent_at": sent_at or datetime.now(timezone.utc).isoformat(),
    }
    body = json.dumps(payload).encode()
    # M6 Fix: Use thread pool instead of spawning unbounded threads
    with ThreadPoolExecutor(max_workers=min(len(urls), 10)) as executor:
        for url in urls:
            executor.submit(_post, url, body)


def _post(url: str, body: bytes) -> None:
    try:
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", "User-Agent": "manhwa-backend/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status >= 300:
                logger.warn("outbound webhook non-2xx", url=url[:60], status=r.status)
    except Exception as e:
        logger.warn("outbound webhook failed", url=url[:60], err=str(e)[:120])


def _to_num(v) -> float | None:
    try:
        return float(v)
    except (ValueError, TypeError):
        return None
