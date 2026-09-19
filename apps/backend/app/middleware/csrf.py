"""CSRF double-submit middleware."""
from fastapi import Request
from fastapi.responses import JSONResponse
from app.config import settings

_CSRF_WHITELIST = {"/api/v1/auth", "/api/v1/interactive", "/api/v1/whitelist", "/api/v1/dispatch-history", "/api/v1/excluded-titles"}


async def csrf_middleware(request: Request, call_next):
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        if request.headers.get("authorization", "").lower().startswith("bearer "):
            return await call_next(request)
        if request.cookies.get("monitor_auth") == settings.MONITOR_AUTH_TOKEN:
            return await call_next(request)
        # No CSRF cookie present → cross-origin API call (not same-origin form)
        # CSRF protection doesn't apply; rely on Bearer/cookie auth above
        if not request.cookies.get("ikiru_csrf_token"):
            return await call_next(request)
        _path = request.url.path.rstrip("/")
        if _path in {p.rstrip("/") for p in _CSRF_WHITELIST}:
            return await call_next(request)
        cookie_token = request.cookies.get("ikiru_csrf_token", "")
        header_token = request.headers.get("x-csrf-token", "")
        if not cookie_token or not header_token or cookie_token != header_token:
            return JSONResponse(content={"success": False, "error": "CSRF validation failed"}, status_code=403)
    return await call_next(request)
