"""CSRF double-submit middleware."""
from fastapi import Request
from fastapi.responses import JSONResponse

_CSRF_WHITELIST = {"/api/v1/auth", "/api/v1/interactive", "/api/v1/cron"}


async def csrf_middleware(request: Request, call_next):
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        if request.headers.get("authorization", "").lower().startswith("bearer "):
            return await call_next(request)
        _path = request.url.path.rstrip("/")
        if _path in {p.rstrip("/") for p in _CSRF_WHITELIST}:
            return await call_next(request)
        cookie_token = request.cookies.get("ikiru_csrf_token", "")
        header_token = request.headers.get("x-csrf-token", "")
        if not cookie_token or not header_token or cookie_token != header_token:
            return JSONResponse(content={"success": False, "error": "CSRF validation failed"}, status_code=403)
    return await call_next(request)
