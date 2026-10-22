"""Register Discord slash commands for be-ag-py.

Discord only delivers interactions for commands that are registered via
PUT /applications/{application_id}/commands. Without this, /setrawchannel etc.
never appear in the Discord client picker.

Run:  python register_commands.py
"""
import json
import urllib.request

from app.config import settings

COMMANDS = [
    {
        "name": "add",
        "description": "Add a manga/manhwa title to the whitelist",
        # Require MANAGE_GUILD so a random member can't write to
        # the whitelist DB via the bot (mirrors the HTTP
        # require_monitor_auth gate on POST /api/whitelist).
        "default_member_permissions": "32",
    },
    {"name": "search", "description": "Search titles across sources"},
    {"name": "stats", "description": "Show dispatch + source-health stats"},
    {"name": "help", "description": "Show available commands"},
    {
        "name": "setfilter",
        "description": "Restrict which content types this server receives (empty = all)",
        "default_member_permissions": "32",
        "options": [
            {
                "name": "types",
                "description": "Comma-separated types: manhwa, manga, manhua. Leave empty to receive all.",
                "type": 3,
                "required": False,
            }
        ],
    },
    {
        "name": "setrawchannel",
        "description": "Set the channel for RAW announcements (every new chapter + Add to whitelist button)",
        "default_member_permissions": "32",
        "options": [
            {
                "name": "channel",
                "description": "Channel that receives every new chapter, including non-whitelisted series",
                # type:7 = CHANNEL — Discord scopes the picker to THIS guild,
                # so a member can't pass an arbitrary ID from another server.
                "type": 7,
                "required": True,
            }
        ],
    },
    {
        "name": "setwhitelistchannel",
        "description": "Set the channel for WHITELIST announcements (only whitelisted series)",
        "default_member_permissions": "32",
        "options": [
            {
                "name": "channel",
                "description": "Channel that receives only whitelisted series",
                "type": 7,
                "required": True,
            }
        ],
    },
]


def main() -> None:
    app_id = settings.DISCORD_APPLICATION_ID
    token = settings.DISCORD_BOT_TOKEN
    if not app_id or not token:
        raise SystemExit("DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN not set")

    url = f"https://discord.com/api/v10/applications/{app_id}/commands"
    req = urllib.request.Request(
        url,
        data=json.dumps(COMMANDS).encode(),
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            # Discord rejects urllib's default User-Agent
            # ("Python-urllib/3.x") with 403 Forbidden.
            # A real UA is required.
            "User-Agent": "be-ag-py/1.0",
        },
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read().decode()
        print("HTTP", resp.status)
        print(json.dumps(json.loads(body), indent=2)[:800])


if __name__ == "__main__":
    main()
