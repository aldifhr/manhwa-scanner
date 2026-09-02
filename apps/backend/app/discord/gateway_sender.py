"""Discord notification sender — subprocess gateway bridge.

The VPS IP is banned at Discord's REST API (Cloudflare 1010 / 40333). The
gateway websocket works ONLY when driven by asyncio.run() in a *main*
thread (discord.py's connect() hangs inside a daemon thread on this host).
So we shell out to a short-lived Python subprocess that does the send with
asyncio.run — clean event loop, no thread-loop conflict.

Usage (from cron / dispatch code):
    from app.discord.gateway_sender import send_via_gateway
    send_via_gateway(channel_id, content="...", embeds=[dict])
"""
from __future__ import annotations

import json
import subprocess
import sys
from typing import Optional

from app.config import settings
from app.logger import get_logger

logger = get_logger("discord:gateway")

_BRIDGE = """
import asyncio, json, sys, os, discord
tok = os.environ.get("DISCORD_TOKEN", "")
cid = int(sys.argv[1])
content = sys.argv[2] or None
embeds = json.loads(sys.argv[3]) if sys.argv[3] != "null" else []

async def main():
    intents = discord.Intents.default()
    intents.guilds = True
    client = discord.Client(intents=intents)
    await client.login(tok)
    ch = await client.fetch_channel(cid)
    disc_embeds = []
    for e in embeds:
        try:
            disc_embeds.append(discord.Embed.from_dict(e))
        except Exception:
            pass
    try:
        await ch.send(content=content, embeds=disc_embeds or None)
    except Exception:
        if disc_embeds:
            await ch.send(content=content or "(new chapter)")
    await client.close()

asyncio.run(main())
"""


def send_via_gateway(
    channel_id: str,
    content: Optional[str] = None,
    embeds: Optional[list] = None,
) -> bool:
    """Send a message via Discord gateway in a subprocess. Returns True on success."""
    try:
        import os
        venv_py = os.path.join(os.path.dirname(sys.executable), "python")
        py = venv_py if os.path.exists(venv_py) else sys.executable
        # Token via env var (not argv) — prevents exposure via ps aux / /proc/<pid>/cmdline
        env = {**os.environ, "DISCORD_TOKEN": settings.DISCORD_BOT_TOKEN or ""}
        proc = subprocess.run(
            [py, "-c", _BRIDGE,
             str(channel_id),
             content or "", json.dumps(embeds or [])],
            env=env,
            capture_output=True, text=True, timeout=40,
        )
        if proc.returncode == 0:
            return True
        logger.error("gateway subprocess failed", rc=proc.returncode, stderr=proc.stderr[:200])
        return False
    except subprocess.TimeoutExpired:
        logger.error("gateway subprocess timed out", channel=channel_id)
        return False
    except Exception as e:  # noqa: BLE001
        logger.error("gateway send error", channel=channel_id, err=str(e)[:200])
        return False


def close_gateway() -> None:
    return
