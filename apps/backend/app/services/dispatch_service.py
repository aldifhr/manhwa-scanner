"""Dispatch service — handles Discord notification logic.

Extracted from dispatch_mod.py for cleaner separation.
"""
from __future__ import annotations

import html

from app.db import get_supabase
from app.discord import client as discord
from app.discord.embeds import build_chapter_embed
from app.logger import get_logger
from app.services.shared import fcfs_key
from app.services.resilience import retry_with_backoff, with_circuit_breaker, cb_discord, cb_db

logger = get_logger("services:dispatch")


class DispatchService:
    """Handle chapter dispatch to Discord with FCFS dedupe."""

    @retry_with_backoff(max_retries=3, base_delay=0.3, max_delay=3.0)
    @with_circuit_breaker(cb_db)
    def get_target_channels(self) -> list[str]:
        """Load target channels from guild_settings."""
        res = get_supabase().table("guild_settings").select("channel_id").execute()
        return [r["channel_id"] for r in (res.data or []) if r.get("channel_id")]

    @retry_with_backoff(max_retries=3, base_delay=0.3, max_delay=3.0)
    @with_circuit_breaker(cb_db)
    def get_claimed_keys(self, keys: list[str]) -> set[str]:
        """Return FCFS keys already sent (permanently in dispatch_history)."""
        if not keys:
            return set()
        res = get_supabase().table("dispatch_history").select("fcfs_key").in_("fcfs_key", keys).execute()
        return {r["fcfs_key"] for r in (res.data or []) if r.get("fcfs_key")}

    @retry_with_backoff(max_retries=3, base_delay=0.3, max_delay=3.0)
    @with_circuit_breaker(cb_db)
    def get_claimed_urls(self, urls: list[str]) -> set[str]:
        """Return URLs already in dispatch_history."""
        if not urls:
            return set()
        res = get_supabase().table("dispatch_history").select("chapter_url").in_("chapter_url", urls).execute()
        return {r["chapter_url"] for r in (res.data or []) if r.get("chapter_url")}

    @retry_with_backoff(max_retries=3, base_delay=0.5, max_delay=5.0)
    @with_circuit_breaker(cb_discord)
    def send_chapter(self, item: dict, channel_id: str) -> bool:
        """Send a single chapter notification to Discord."""
        cover_url = item.get("cover", "")
        attachment = None
        attachment_filename = ""

        if cover_url and isinstance(cover_url, str) and cover_url.startswith("http"):
            from app.discord.http import fetch_cover
            result = fetch_cover(cover_url)
            if result:
                content_bytes, content_type = result
                ext = cover_url.rsplit(".", 1)[-1].split("?")[0]
                attachment_filename = f"cover_{fcfs_key(item.get('title', ''), item.get('chapter', ''))[:20]}.{ext}"
                attachment = (attachment_filename, content_bytes, content_type)

        embed = build_chapter_embed(
            title=item.get("title", ""),
            chapter=item.get("chapter", ""),
            url=item.get("url", ""),
            series_url=item.get("series_url", ""),
            source=item.get("source", ""),
            cover=item.get("cover", ""),
            rating=str(item.get("rating", "")),
            genres=item.get("genres", []),
            description=item.get("description", ""),
            updated_time=item.get("updated_time", ""),
        )
        if attachment:
            embed["thumbnail"] = {"url": f"attachment://{attachment_filename}"}

        content = f"🔔 New Release on **{html.unescape(item.get('title', 'Unknown'))}** — Chapter {item.get('chapter', '?')}"

        try:
            if attachment:
                resp = discord.send_channel_message_with_attachments(
                    channel_id=channel_id, content=content, embeds=[embed], attachments=[attachment]
                )
            else:
                resp = discord.send_channel_message(channel_id=channel_id, content=content, embeds=[embed])
            return resp is not None
        except Exception as e:
            logger.warn("send_chapter failed", err=str(e)[:120])
            return False

    def update_latest_sent_chapter(self, title_key: str, source: str, chapter_num: float):
        """Update latest_sent_chapter in whitelist."""
        try:
            from app.db import q
            q("UPDATE whitelist SET latest_sent_chapter = GREATEST(COALESCE(latest_sent_chapter, 0), %s) WHERE title_key = %s AND source = %s",
              [chapter_num, title_key, source])
        except Exception as e:
            logger.warn("update_latest_sent_chapter failed", err=str(e)[:120])

    def update_latest_chapter(self, title_key: str, source: str, chapter_num: float):
        """Update latest_chapter (highest chapter seen/available) in whitelist."""
        try:
            from app.db import q
            q("UPDATE whitelist SET latest_chapter = GREATEST(COALESCE(latest_chapter, 0), %s) WHERE title_key = %s AND source = %s",
              [chapter_num, title_key, source])
        except Exception as e:
            logger.warn("update_latest_chapter failed", err=str(e)[:120])


# Singleton
dispatch_service = DispatchService()
