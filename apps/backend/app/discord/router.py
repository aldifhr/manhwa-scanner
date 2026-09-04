"""Discord interaction router (parity with api/interactive.ts + lib/commands/*)."""
from __future__ import annotations

import json

from app.config import settings
from app.logger import get_logger

logger = get_logger("discord:router")

# InteractionType / ResponseType constants
PING = 1
APPLICATION_COMMAND = 2
MESSAGE_COMPONENT = 3
CHANNEL_MESSAGE_WITH_SOURCE = 4
DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5


def _extract_options(data: dict) -> dict:
    opts = {}
    for o in data.get("options", []) or []:
        if "value" in o:
            opts[o["name"]] = o.get("value")
        elif "options" in o:  # subcommand
            opts[o["name"]] = _extract_options(o)
    return opts


def _respond(response_type: int, data: dict | None = None) -> dict:
    resp = {"type": response_type}
    if data is not None:
        resp["data"] = data
    return resp


def handle_interaction(raw_body: bytes) -> tuple[int, dict]:
    """Returns (http_status, json_body)."""
    try:
        payload = json.loads(raw_body)
    except Exception:
        return 400, {"error": "invalid_json"}

    itype = payload.get("type")

    if itype == PING:
        return 200, _respond(1)  # PONG

    data = payload.get("data", {}) or {}
    name = data.get("name")
    custom_id = data.get("custom_id", "")

    # Defer + handle async (we respond with DEFERRED, then edit)
    if itype in (APPLICATION_COMMAND, MESSAGE_COMPONENT):
        # route
        if name == "add":
            return _route_add(payload, data)
        if name == "search":
            return _route_search(data)
        if name == "stats":
            return _route_stats(data)
        if name == "help":
            return 200, _respond(
                CHANNEL_MESSAGE_WITH_SOURCE,
                {"content": "Available: /add, /search, /stats, /help, /setchannel"},
            )
        if name == "setchannel":
            return _route_setchannel(payload, data)
        if name == "setfilter":
            return _route_setfilter(payload, data)
        if custom_id.startswith("list:"):
            return _route_list_component(custom_id)
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE,
            {"content": f"Unknown command `/{name}`. Available: `/add`, `/search`, `/stats`, `/help`, `/setchannel`, `/setfilter`"},
        )

    return 400, {"error": "unsupported_interaction"}


def _route_add(payload: dict, data: dict):
    opts = _extract_options(data)
    title = opts.get("title", "")
    url = opts.get("link", "") or opts.get("url", "")
    # queue to background (deferred)
    from app.tasks import enqueue_add

    enqueue_add(title=title, url=url, interaction=payload)
    return 200, _respond(
        DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        {"content": f"⏳ Adding **{title}**..."},
    )


def _route_search(data: dict):
    opts = _extract_options(data)
    q = opts.get("query", "")
    from app.scrapers import ikiru, shinigami

    results = ikiru.search_ikiru_api(q, 5) + shinigami.search_shinigami_api(q, 5)
    if not results:
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE, {"content": f"No results for `{q}`"}
        )
    lines = [f"🔍 **{q}**"]
    for r in results[:10]:
        t = r.get("title", "?")
        lines.append(f"• {t}")
    return 200, _respond(CHANNEL_MESSAGE_WITH_SOURCE, {"content": "\n".join(lines)})


def _route_stats(data: dict):
    from app.storage import whitelist

    rows = whitelist.load_whitelist()
    return 200, _respond(
        CHANNEL_MESSAGE_WITH_SOURCE,
        {"content": f"📊 Whitelist: **{len(rows)}** manga tracked"},
    )


def _route_setchannel(payload: dict, data: dict):
    opts = _extract_options(data)
    channel_id = opts.get("channel", "")
    guild_id = payload.get("guild_id", "")
    if not channel_id or not guild_id:
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE,
            {"content": "❌ Missing channel or guild"},
        )
    # Defense: only accept guilds in the allowlist.
    _raw = getattr(settings, "DISCORD_GUILD_ID", "") or ""
    allowed = [g.strip() for g in _raw.split(",") if g.strip()]
    if allowed and guild_id not in allowed:
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE,
            {"content": "❌ Channel must belong to an authorized server"},
        )
    # Respond within 3s — do DB upsert in thread, fallback to deferred on slow DB
    try:
        from app.db import get_supabase
        def _do_upsert():
            return get_supabase().table("guild_settings").upsert(
                {"guild_id": guild_id, "channel_id": str(channel_id)},
                on_conflict="guild_id",
            ).execute()
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=1) as _ex:
            _ex.submit(_do_upsert).result(timeout=2.5)
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE,
            {"content": f"✅ Notifications will be sent to <#{channel_id}>\nUse `/setfilter` to restrict origins (KR/CN/JP) for this server."},
        )
    except TimeoutError:
        logger.warn("setchannel DB timeout", guild=guild_id, channel=channel_id)
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE,
            {"content": "⏳ Channel save is slow — try again in 5s (DB timeout). If persists, check /health."},
        )
    except Exception as e:
        logger.warn("setchannel failed", err=str(e)[:200])
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE,
            {"content": f"❌ Failed to set channel: {e}"[:1900]},
        )


def _route_setfilter(payload: dict, data: dict):
    """Per-guild origin filter: /setfilter origins:KR,CN — empty = all."""
    opts = _extract_options(data)
    guild_id = payload.get("guild_id", "")
    origins_raw = (opts.get("origins") or "").upper()
    origins = {o.strip() for o in origins_raw.split(",") if o.strip()}
    bad = origins - {"KR", "CN", "JP"}
    if bad:
        return 200, _respond(
            CHANNEL_MESSAGE_WITH_SOURCE,
            {"content": f"❌ Invalid origins: {', '.join(sorted(bad))}. Use KR, CN, JP (comma-separated, empty = all)."},
        )
    if not guild_id:
        return 200, _respond(CHANNEL_MESSAGE_WITH_SOURCE, {"content": "❌ Missing guild"})
    try:
        from app.db import get_supabase
        get_supabase().table("guild_settings").upsert(
            {"guild_id": guild_id, "origin_filter": ",".join(sorted(origins))},
            on_conflict="guild_id",
        ).execute()
        msg = f"✅ This server will now receive: **{', '.join(sorted(origins))}**" if origins else "✅ Filter cleared — this server receives ALL origins"
        return 200, _respond(CHANNEL_MESSAGE_WITH_SOURCE, {"content": msg})
    except Exception as e:
        return 200, _respond(CHANNEL_MESSAGE_WITH_SOURCE, {"content": f"❌ Failed: {e}"})


def _route_list_component(custom_id: str):
    parts = custom_id.split(":")
    page = int(parts[1]) if len(parts) > 1 else 1
    return 200, _respond(
        CHANNEL_MESSAGE_WITH_SOURCE,
        {"content": f"📄 Page {page} (list view WIP)"},
    )
