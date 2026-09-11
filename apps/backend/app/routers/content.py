"""Content routers — activity/rss_custom/public/continue/ws/whitelist/queue."""
from app.api import settings as settings_api, activity as activity_api, public_stats as public_stats_api, continue_reading as continue_reading_api, rss_custom as rss_custom_api, scan_status as scan_status_api
from app.api.websocket import router as websocket_router
from app.api import queue_dashboard as queue_dashboard_api


def register_content(app):
    app.include_router(settings_api.router, prefix="/api/v1")
    app.include_router(activity_api.router, prefix="/api/v1")
    app.include_router(rss_custom_api.router, prefix="/api/v1")
    app.include_router(public_stats_api.router, prefix="/api/v1")
    app.include_router(continue_reading_api.router, prefix="/api/v1")
    app.include_router(scan_status_api.router, prefix="/api/v1")
    app.include_router(websocket_router)
    app.include_router(queue_dashboard_api.router)
