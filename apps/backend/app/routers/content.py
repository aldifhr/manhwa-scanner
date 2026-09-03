"""Content routers — activity/analytics/rss_custom/public/continue/bookmark/ws/whitelist/queue."""
from app.api import settings as settings_api, activity as activity_api, public_stats as public_stats_api, continue_reading as continue_reading_api
from app.api import analytics as analytics_api, reading_stats as reading_stats_api, rss_custom as rss_custom_api, bookmark as bookmark_api
from app.api.websocket import router as websocket_router
from app.api.dashboard import whitelist as whitelist_api
from app.api import queue_dashboard as queue_dashboard_api
from fastapi import APIRouter, Request

def register_content(app):
    _settings_router = APIRouter()
    @_settings_router.get("/settings")
    async def _settings_get(request: Request):
        return await settings_api.settings_get(request)
    @_settings_router.put("/settings/{guild_id}")
    async def _settings_put(request: Request, guild_id: str):
        return await settings_api.settings_put(request, guild_id)
    app.include_router(_settings_router, prefix="/api/v1")
    app.include_router(activity_api.router, prefix="/api/v1")
    app.include_router(analytics_api.router, prefix="/api/v1")
    app.include_router(reading_stats_api.router, prefix="/api/v1")
    app.include_router(rss_custom_api.router, prefix="/api/v1")
    app.include_router(public_stats_api.router, prefix="/api/v1")
    app.include_router(continue_reading_api.router, prefix="/api/v1")
    app.include_router(bookmark_api.router)
    app.include_router(websocket_router)
    app.include_router(whitelist_api.router, prefix="/api/v1")
    app.include_router(queue_dashboard_api.router)
