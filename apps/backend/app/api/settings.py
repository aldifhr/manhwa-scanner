"""Web settings API — manage per-guild notification settings from the FE.

GET  /api/settings            -> list guild rows (safe fields only)
PUT  /api/settings/{guild_id} -> update origin_filter / excluded_titles / label

Auth: PUT requires admin role (require_role_auth {"admin"}); GET is monitor-only.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from app.utils.request_auth import require_role_auth, safe_error
from app.cron.dispatch_mod import load_guild_settings
from app.logger import get_logger

logger = get_logger("api:settings")

_VALID_ORIGINS = {"KR", "CN", "JP"}


def _clean_origins(raw) -> list[str]:
    if isinstance(raw, str):
        parts = raw.split(",")
    elif isinstance(raw, (list, tuple)):
        parts = [str(x) for x in raw]
    else:
        return []
    return sorted({o.strip().upper() for o in parts if o.strip()})


async def settings_get(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        rows = load_guild_settings()
        out = []
        for g in rows:
            origins_raw = str(g.get("origin_filter") or "")
            from app.cron.dispatch_mod import _guild_name
            out.append({
                "guildId": str(g.get("guild_id") or ""),
                "guildName": _guild_name(str(g.get("guild_id") or "")),
                "channelId": str(g.get("channel_id") or ""),
                "label": str(g.get("label") or ""),
                "originFilter": [o for o in origins_raw.split(",") if o],
                "excludedTitles": list(g.get("excluded_titles") or []),
            })
        return JSONResponse(content={"success": True, "data": {"guilds": out}})
    except Exception as e:
        logger.warn("settings GET failed", err=str(e))
        return JSONResponse(content=safe_error(e), status_code=500)


async def settings_put(request: Request, guild_id: str):
    # Destructive-ish write (changes guild notification policy) — admin only.
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse(content={"success": False, "error": "body must be an object"}, status_code=400)

    update: dict = {}
    if "originFilter" in body:
        origins = _clean_origins(body.get("originFilter"))
        bad = set(origins) - _VALID_ORIGINS
        if bad:
            return JSONResponse(content={
                "success": False,
                "error": f"invalid origins: {', '.join(sorted(bad))} (allowed: KR, CN, JP)",
            }, status_code=400)
        update["origin_filter"] = ",".join(origins)
    if "excludedTitles" in body:
        titles = body.get("excludedTitles")
        if not isinstance(titles, list) or not all(isinstance(t, str) for t in titles):
            return JSONResponse(content={"success": False, "error": "excludedTitles must be a string array"}, status_code=400)
        update["excluded_titles"] = [t.strip() for t in titles if t.strip()]
    if "label" in body:
        update["label"] = str(body.get("label") or "")[:60]

    if not update:
        return JSONResponse(content={"success": False, "error": "nothing to update"}, status_code=400)

    try:
        from app.db import get_supabase
        res = (
            get_supabase()
            .table("guild_settings")
            .update(update)
            .eq("guild_id", guild_id)
            .execute()
        )
        if not (res.data or []):
            return JSONResponse(content={"success": False, "error": "guild not found"}, status_code=404)
        g = res.data[0]
        return JSONResponse(content={
            "success": True,
            "data": {
                "guildId": str(g.get("guild_id") or ""),
                "originFilter": [o for o in str(g.get("origin_filter") or "").split(",") if o],
                "excludedTitles": list(g.get("excluded_titles") or []),
                "label": str(g.get("label") or ""),
            },
        })
    except Exception as e:
        logger.warn("settings PUT failed", err=str(e))
        return JSONResponse(content=safe_error(e), status_code=500)
