"""Cron monitor endpoint — exposes internal scheduler status for the /cron page.

The scheduler only runs inside the ROLE=cron worker (port 3001). This
endpoint is mounted on BOTH processes, but the API process (port 3000)
doesn't run the scheduler, so its local get_cron_status() reports
scheduler_alive=False. To give the VPS /cron monitor page a single public
URL, we proxy to the cron worker on 127.0.0.1:3001 when this process isn't
the scheduler. Read-only; safe to call without auth.
"""
from __future__ import annotations

import json
import urllib.request

from fastapi import APIRouter, Request

from app.tasks import get_cron_status
from app.utils.request_auth import safe_error

router = APIRouter()

_CRON_WORKER_URL = "http://127.0.0.1:3001/api/v1/cron/status"


@router.get("/cron/status")
async def cron_status(request: Request):
    try:
        local = get_cron_status()
        if local.get("scheduler_alive"):
            return local
    except Exception:
        local = None
    # Not the scheduler process — proxy to the cron worker on localhost:3001.
    try:
        with urllib.request.urlopen(_CRON_WORKER_URL, timeout=3) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        if local is not None:
            # Cron worker unreachable but we still have DB/Redis signals.
            local["scheduler_alive"] = False
            local["worker_reachable"] = False
            return local
        return safe_error(e, f"cron status unavailable: {e}")
