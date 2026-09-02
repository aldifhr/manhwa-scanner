"""Dashboard API routes — split into per-domain routers.

Aggregates whitelist / catalog / stats sub-routers into a single `router`
so `main.py` can keep doing `from app.api import dashboard; dashboard.router`.
"""
from fastapi import APIRouter

from app.api.dashboard import whitelist as _wl
from app.api.dashboard import catalog as _cat
from app.api.dashboard import stats as _stats
from app.api.dashboard import excluded_titles as _excl

router = APIRouter()
router.include_router(_wl.router)
router.include_router(_cat.router)
router.include_router(_stats.router)
router.include_router(_excl.router)
