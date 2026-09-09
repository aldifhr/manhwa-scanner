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
import time
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
    import os

    # Resolve venv python explicitly — subprocess inherits parent env which
    # may point to system python instead of venv (uv installs system-wide).
    venv_bin = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".venv", "bin")
    venv_py = os.path.join(venv_bin, "python")
    py = venv_py if os.path.exists(venv_py) else sys.executable
    env = {
        **os.environ,
        "DISCORD_TOKEN": settings.DISCORD_BOT_TOKEN or "",
        "VIRTUAL_ENV": os.path.dirname(venv_bin),
        "PATH": venv_bin + ":" + os.environ.get("PATH", ""),
    }
    # ponytail: retry with exponential backoff to avoid 1/sec subprocess burst on REST ban
    for attempt in range(3):
        try:
            proc = subprocess.run(
                [py, "-c", _BRIDGE,
                 str(channel_id),
                 content or "", json.dumps(embeds or [])],
                env=env,
                capture_output=True, text=True, timeout=40,
            )
            if proc.returncode == 0:
                return True
            # log full stderr (not truncated to 200) for debugging gateway hangs
            err_out = (proc.stderr or "")[:2000]
            out_out = (proc.stdout or "")[:500]
            logger.error("gateway subprocess failed", rc=proc.returncode, attempt=attempt + 1, stderr=err_out, stdout=out_out)
        except subprocess.TimeoutExpired:
            logger.error("gateway subprocess timed out", channel=channel_id, attempt=attempt + 1)
        except Exception as e:  # noqa: BLE001
            logger.error("gateway send error", channel=channel_id, attempt=attempt + 1, err=str(e)[:500])
            # non-retryable setup error — don't spin
            return False
        if attempt < 2:
            time.sleep(1 * (2 ** attempt))  # 1s, 2s (4s cooldown after 3rd fail avoided — caller sleeps 0.8s)
    return False


def close_gateway() -> None:
    return
