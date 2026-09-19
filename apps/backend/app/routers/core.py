"""Core routers — health/admin/catalog/auth/dispatch."""
from app.api import catalog as catalog_api, auth as auth_api, dispatches as dispatches_api, observability as observability_api, system as system_api, rss as rss_api, health as health_api, cover as cover_api, cron as cron_api, history as history_api, incidents as incidents_api
from app.api.admin import catalog as admin_catalog_api, whitelist as admin_whitelist_api, stats as admin_stats_api, excluded as admin_excluded_api


def register_core(app):
    app.include_router(health_api.router, prefix="/api/v1")
    app.include_router(admin_catalog_api.router, prefix="/api/v1")
    app.include_router(admin_whitelist_api.router, prefix="/api/v1")
    app.include_router(admin_stats_api.router, prefix="/api/v1")
    app.include_router(admin_excluded_api.router, prefix="/api/v1")
    app.include_router(catalog_api.router, prefix="/api/v1")
    app.include_router(auth_api.router, prefix="/api/v1")
    app.include_router(dispatches_api.router, prefix="/api/v1")
    app.include_router(observability_api.router, prefix="/api/v1")
    app.include_router(history_api.router, prefix="/api/v1")
    app.include_router(incidents_api.router, prefix="/api/v1")
    app.include_router(cover_api.router, prefix="/api/v1")
    app.include_router(rss_api.router, prefix="/api/v1")
    app.include_router(cron_api.router, prefix="/api/v1")
    app.include_router(system_api.router, prefix="/api/v1")
