"""Content routers — activity/rss_custom/public/ws/whitelist/queue."""
from app.api import activity as activity_api, public_stats as public_stats_api, rss_custom as rss_custom_api


def register_content(app):
    app.include_router(activity_api.router, prefix="/api/v1")
    app.include_router(rss_custom_api.router, prefix="/api/v1")
    app.include_router(public_stats_api.router, prefix="/api/v1")
