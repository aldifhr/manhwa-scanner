"""Legacy /api -> /api/v1 compat — one prefix rewrite."""
from fastapi import Request

async def legacy_redirect_middleware(request: Request, call_next):
    path = request.url.path
    # ponytail: generic /api/→/api/v1/ rewrite (catch-all), restore allowlist when non-v1 /api/* route needs distinct handling
    if path.startswith("/api/") and not path.startswith("/api/v1/") and not path.startswith("/api/docs") and not path.startswith("/api/openapi"):
        from fastapi.responses import RedirectResponse
        qs = str(request.query_params)
        url = "/api/v1/" + path[len("/api/"):] + (f"?{qs}" if qs else "")
        return RedirectResponse(url=url, status_code=307)
    return await call_next(request)
