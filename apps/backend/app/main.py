"""FastAPI app — <120L (lifespan/CORS/uvicorn extracted)."""
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.lifespan import lifespan
from app.logger import get_logger

logger = get_logger("hono-server")

from app.routers import register_routers


app = FastAPI(
    title="manhwa-backend",
    version="1.0.0",
    description="Ikiru Bot manhwa scraper API. Use Bearer token for protected endpoints.",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

from app.middleware.cors import add_cors  # noqa: E402
add_cors(app)
from app.middleware.correlation import correlation_middleware  # noqa: E402
from app.middleware.security import security_headers_middleware  # noqa: E402
app.middleware("http")(correlation_middleware)
app.middleware("http")(security_headers_middleware)


from app.utils.request_auth import safe_error, require_monitor_auth

# CSRF/metrics/legacy now in app/middleware/* (extracted)


# --- OpenAPI / routers / legacy — extracted ---
from app.api.openapi import custom_openapi  # noqa: E402
app.openapi = lambda: custom_openapi(app)
from app.middleware.legacy import legacy_redirect_middleware  # noqa: E402
from app.middleware.csrf import csrf_middleware  # noqa: E402
from app.middleware.metrics import metrics_middleware  # noqa: E402
app.middleware("http")(legacy_redirect_middleware)
app.middleware("http")(csrf_middleware)
app.middleware("http")(metrics_middleware)
register_routers(app)

# Health/detailed now in app/api/health.py; metrics stays here (gated)
@app.get("/metrics")
async def metrics_root(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.metrics_prometheus import get_metrics
    return get_metrics()

# --- Reader alias router REMOVED (MAN-011) ---
# The /api/reader/* aliases (/reader/rss, /reader/dashboard, /reader/stats,
# /reader/sources/health, /reader/catalog/*, /reader/dispatch-history) were
# thin pass-through wrappers to the canonical /api/* handlers. The FE no longer
# calls any of them (verified: 0 references in fe-ag), so they only added
# maintenance burden + attack surface. Canonical endpoints under /api/* remain.
# Note: /api/reader/cover, /api/reader/cover-img, /api/reader/proxy and
# /api/reader/whitelist are REAL endpoints (used by FE/discord), NOT aliases —
# those stay.


@app.get("/api/v1/openapi.json")
async def api_openapi(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    return JSONResponse(content=custom_openapi())


# --- Uniform JSON error responses (no HTML leaks to the FE) ---
from fastapi import HTTPException as _HTTPException
from fastapi.exceptions import RequestValidationError as _RequestValidationError
from starlette.exceptions import HTTPException as _StarletteHTTPException


@app.exception_handler(_HTTPException)
@app.exception_handler(_StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: _HTTPException):
    _CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden",
              404: "not_found", 429: "rate_limited", 500: "internal_error"}
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": _CODES.get(exc.status_code, "error"),
            "message": (exc.detail if isinstance(exc.detail, str) else "request failed"),
        },
    )


@app.exception_handler(_RequestValidationError)
async def _validation_handler(request: Request, exc: _RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": "validation_error", "message": "Invalid request parameters."},
    )


@app.exception_handler(Exception)
async def _unhandled_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "message": "Internal server error."},
    )


# --- Discord interaction endpoint (B2 fix) ---
@app.post("/api/v1/interactive")
async def api_interactive(request: Request):
    """Discord interaction endpoint — verifies Ed25519 signature and routes."""
    from app.discord import client as _disc
    from app.discord.router import handle_interaction

    signature = request.headers.get("x-signature-ed25519", "")
    timestamp = request.headers.get("x-signature-timestamp", "")
    body = await request.body()

    if not _disc.verify_interaction(body, signature, timestamp):
        return JSONResponse(content={"error": "invalid signature"}, status_code=401)

    status_code, response_body = handle_interaction(body)
    return JSONResponse(content=response_body, status_code=status_code)


if __name__ == "__main__":
    from app.runner import run as _run
    _run(app)
