"""Lifespan — startup/shutdown for FastAPI (extracted from main.py:28)."""
from contextlib import asynccontextmanager
import os
import threading

from fastapi import FastAPI

from app.logger import get_logger

logger = get_logger("hono-server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.tasks import start_worker
    start_worker()
    _role = (os.environ.get("ROLE") or "api").lower()
    if _role == "cron":
        from app.tasks import run_cron_worker, start_cron_scheduler
        threading.Thread(target=run_cron_worker, daemon=True, name="cron-worker").start()
        start_cron_scheduler()
        logger.info("cron-worker started (ROLE=cron)")
    logger.info("application startup complete")
    yield
    logger.info("application shutting down — closing connections")
    try:
        from app.discord import client as _disc
        _disc.close_discord_client()
    except Exception:
        pass
    try:
        from app.discord.http import _CoverClient
        _CoverClient.close()
    except Exception:
        pass
    try:
        from app.db import close_pool as _close_pool
        _close_pool()
    except Exception:
        pass
    try:
        from app.tasks import stop_worker as _stop_worker
        _stop_worker()
    except Exception:
        pass
