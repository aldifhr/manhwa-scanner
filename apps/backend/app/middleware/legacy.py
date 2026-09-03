"""Legacy /api -> /api/v1 redirects."""
from fastapi import Request

_LEGACY_REDIRECTS = {
    "/api/auth": "/api/v1/auth",
    "/api/whitelist": "/api/v1/whitelist",
    "/api/history": "/api/v1/dispatch-history",
    "/api/excluded-titles": "/api/v1/excluded-titles",
    "/api/rss": "/api/v1/rss",
    "/api/rss/new": "/api/v1/rss/new",
    "/api/rss/health": "/api/v1/rss/health",
    "/api/rss/custom": "/api/v1/rss/custom",
    "/api/rss/filters/metadata": "/api/v1/rss/filters/metadata",
    "/api/health": "/api/v1/health",
    "/api/cron": "/api/v1/cron",
    "/api/settings": "/api/v1/settings",
    "/api/queue": "/api/v1/queue",
    "/api/stats": "/api/v1/stats",
    "/api/analytics": "/api/v1/analytics",
    "/api/bookmarks": "/api/v1/bookmarks",
    "/api/reader/dispatch-history": "/api/v1/dispatch-history",
    "/api/dispatch-history": "/api/v1/dispatch-history",
    "/api/reader/stats": "/api/v1/stats",
    "/api/reader/queue": "/api/v1/queue",
    "/api/reader/cron/status": "/api/v1/cron/status",
    "/api/reader/continue-reading": "/api/v1/continue-reading",
    "/api/reader/rss": "/api/v1/rss",
    "/api/reader/rss/new": "/api/v1/rss/new",
    "/api/reader/rss/health": "/api/v1/rss/health",
    "/api/reader/cover": "/api/v1/reader/cover",
    "/api/reader/cover-img": "/api/v1/reader/cover-img",
    "/api/redirect/chapter": "/api/v1/redirect/chapter",
}


async def legacy_redirect_middleware(request: Request, call_next):
    path = request.url.path
    if path in _LEGACY_REDIRECTS:
        from fastapi.responses import RedirectResponse
        qs = str(request.query_params)
        url = _LEGACY_REDIRECTS[path] + (f"?{qs}" if qs else "")
        return RedirectResponse(url=url, status_code=307)
    return await call_next(request)
