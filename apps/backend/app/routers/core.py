"""Core routers — health/dashboard/catalog/auth/dispatch."""
from app.api import dashboard as dashboard_api, catalog as catalog_api, auth as auth_api, dispatches as dispatches_api, observability as observability_api, system as system_api, rss as rss_api, health as health_api, error_logs as error_logs_api
from app.api.cron_status import router as _cron_status_router

def register_core(app):
    app.include_router(health_api.router, prefix="/api/v1")
    app.include_router(dashboard_api.router, prefix="/api/v1")
    app.include_router(catalog_api.router, prefix="/api/v1")
    app.include_router(auth_api.router, prefix="/api/v1")
    app.include_router(dispatches_api.router, prefix="/api/v1")
    app.include_router(observability_api.router, prefix="/api/v1")
    app.include_router(rss_api.router, prefix="/api/v1")
    app.include_router(_cron_status_router, prefix="/api/v1")
    app.include_router(system_api.router, prefix="/api/v1")
    app.include_router(error_logs_api.router, prefix="/api/v1")
