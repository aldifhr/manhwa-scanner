"""Discord interaction crypto + HTTP sender (parity with lib/discord/*)."""
from __future__ import annotations

import json
import random
import time
import httpx
from discord_interactions import verify_key

from app.config import settings
from app.logger import get_logger
from app.services.resilience import cb_discord

logger = get_logger("discord")

_HEADERS = {"User-Agent": "DiscordBot (https://github.com/aldifhr/be-ag-py, 1.0)"}

# Shared httpx client for Discord API (avoids socket churn)
_discord_client: httpx.Client | None = None


def _get_discord_client() -> httpx.Client:
    global _discord_client
    if _discord_client is None:
        _discord_client = httpx.Client(timeout=10, headers=_HEADERS)
    return _discord_client


def close_discord_client() -> None:
    global _discord_client
    if _discord_client is not None:
        _discord_client.close()
        _discord_client = None


def verify_interaction(raw_body: bytes, signature: str, timestamp: str) -> bool:
    """Verify Ed25519 signature from Discord."""
    if not settings.DISCORD_PUBLIC_KEY:
        logger.warn("DISCORD_PUBLIC_KEY not set — refusing")
        return False
    try:
        logger.info("verify_interaction", sig_len=len(signature), ts_len=len(timestamp), body_len=len(raw_body))
        result = verify_key(
            raw_body,
            signature,
            timestamp,
            settings.DISCORD_PUBLIC_KEY,
        )
        if not result:
            logger.warn("verify_interaction returned False", sig_len=len(signature))
        return result
    except Exception as e:
        logger.error("verify_interaction error", exc=e)
        return False


def _decode_discord_public_key(pk: str) -> bytes:
    """Decode Discord public key — handles both hex and base64url formats."""
    try:
        # Try hex first (what discord_interactions.verify_key expects)
        decoded = bytes.fromhex(pk)
        if len(decoded) == 32:
            return decoded
    except ValueError:
        pass
    # Try base64url (what Discord Portal actually shows)
    import base64
    try:
        decoded = base64.urlsafe_b64decode(pk + "==")
        if len(decoded) == 32:
            return decoded
    except Exception:
        pass
    raise ValueError(f"Unable to decode Discord public key (len={len(pk)})")


def verify_interaction_v2(raw_body: bytes, signature: str, timestamp: str) -> bool:
    """Verify Ed25519 signature from Discord — handles base64url PK format."""
    if not settings.DISCORD_PUBLIC_KEY:
        logger.warn("DISCORD_PUBLIC_KEY not set — refusing")
        return False
    try:
        pk_bytes = _decode_discord_public_key(settings.DISCORD_PUBLIC_KEY)
        from nacl.signing import VerifyKey
        vk = VerifyKey(pk_bytes)
        # Discord sends signature as hex (64 bytes = 128 hex chars)
        sig_bytes = bytes.fromhex(signature)
        vk.verify(timestamp.encode() + raw_body, sig_bytes)
        logger.info("verify_interaction OK", sig_len=len(signature))
        return True
    except Exception as e:
        logger.error("verify_interaction error", exc=e)
        return False


def _discord_request(method: str, url: str, *, json_data: dict | None = None, files: dict | None = None, max_retries: int = 3) -> httpx.Response | None:
    """Send a Discord API request with 429 + Retry-After handling.

    D1 FIX: Reads Retry-After header on 429, uses exponential backoff with jitter.
    Circuit-aware: fast-fails when discord CB is OPEN.
    """
    if not cb_discord.allow():
        logger.warn("discord circuit OPEN — dropping request", method=method)
        return None
    headers = {**_HEADERS, "Authorization": f"Bot {settings.DISCORD_BOT_TOKEN}"}
    client = _get_discord_client()

    for attempt in range(max_retries + 1):
        try:
            if files is not None:
                r = client.request(method, url, files=files, headers=headers)
            elif json_data is not None:
                r = client.request(method, url, json=json_data, headers=headers)
            else:
                r = client.request(method, url, headers=headers)

            if r.status_code < 400:
                cb_discord.record_success()
                return r
            if r.status_code == 429:
                retry_after = r.headers.get("retry-after")
                if retry_after:
                    try:
                        wait = float(retry_after)
                    except (ValueError, TypeError):
                        wait = min(2 ** attempt, 30) + random.uniform(0, 1.0)
                else:
                    wait = min(2 ** attempt, 30) + random.uniform(0, 1.0)
                logger.warn("Discord 429 rate limited", wait=round(wait, 2), attempt=attempt)
                time.sleep(wait)
                continue
            if r.status_code >= 500:
                cb_discord.record_failure()
            return r
        except Exception as e:
            cb_discord.record_failure()
            logger.error("discord request failed", method=method, err=str(e))
            if attempt < max_retries:
                time.sleep(min(2 ** attempt, 10) + random.uniform(0, 1.0))
                continue
            return None
    cb_discord.record_failure()
    return None


def send_channel_message(channel_id: str, content: str | None = None, embeds: list | None = None):
    """Send a message to a channel via bot token.

    Primary path: Discord REST API. If that fails (e.g. VPS IP banned at
    the REST layer — Cloudflare 1010 / Discord 40333), fall back to the
    gateway websocket sender.
    """
    try:
        r = _discord_request("POST", f"https://discord.com/api/v10/channels/{channel_id}/messages", json_data=_build_payload(content, embeds))
        if r is not None and r.status_code < 400:
            return r.json()
    except Exception as e:
        logger.warn("send_channel_message REST failed, trying gateway", channel=channel_id, err=str(e)[:120])

    # Fallback: gateway websocket (not IP-banned like REST)
    try:
        from app.discord.gateway_sender import send_via_gateway
        if send_via_gateway(channel_id, content=content, embeds=embeds):
            return {"id": "gateway", "channel_id": channel_id}
    except Exception as e:
        logger.error("send_channel_message gateway fallback failed", channel=channel_id, err=str(e)[:160])
    return None


def _build_payload(content, embeds):
    payload: dict = {}
    if content is not None:
        payload["content"] = content
    if embeds:
        payload["embeds"] = embeds
    return payload



def send_channel_message_with_attachments(
    channel_id: str,
    content: str | None = None,
    embeds: list | None = None,
    attachments: list[tuple[str, bytes, str]] | None = None,
):
    """Send a message with file attachments."""
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    payload: dict[str, object] = {}
    if content is not None:
        payload["content"] = content
    if embeds:
        payload["embeds"] = embeds

    # C4 Fix: Try REST with files FIRST (before gateway fallback)
    if attachments:
        files = {f"file{i}": (name, data, mime) for i, (name, data, mime) in enumerate(attachments)}
        files["payload_json"] = ("", json.dumps(payload), "application/json")
        try:
            r = _discord_request("POST", url, files=files)
            if r is not None and r.status_code < 400:
                return r.json()
            logger.warn("send w/ attachments REST failed", status=r.status_code if r else None, channel=channel_id)
        except Exception as e:
            logger.warn("send w/ attachments REST error", err=str(e)[:120])

    # No attachments, or REST failed — try plain REST
    try:
        r = _discord_request("POST", url, json_data=payload)
        if r is not None and r.status_code < 400:
            return r.json()
    except Exception as e:
        logger.warn("send REST failed, trying gateway", err=str(e)[:120])

    # Gateway fallback (no file attachments)
    try:
        from app.discord.gateway_sender import send_via_gateway
        if send_via_gateway(channel_id, content=content, embeds=embeds):
            return {"id": "gateway", "channel_id": channel_id}
    except Exception as e:
        logger.error("gateway fallback failed", err=str(e)[:160])
    return None
