"""FastAPI app (parity with lib/hono-app.ts + api/interactive.ts)."""
from contextlib import asynccontextmanager
import os
import threading

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.logger import get_logger

logger = get_logger("hono-server")

from app.routers import register_routers
from fastapi.openapi.utils import get_openapi  # kept for custom_openapi delegate


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: init resources. Shutdown: close connections gracefully."""
    from app.tasks import start_worker
    start_worker()
    # Cron decoupling: the ROLE=cron process runs the cron queue worker so the
    # (slow, upstream-heavy) scrape/dispatch never runs inside the HTTP API
    # process. FastCron hits /api/cron on the API process, which enqueues to
    # Redis; the cron worker pops and executes run_pipeline.
    _role = (os.environ.get("ROLE") or "api").lower()
    if _role == "cron":
        from app.tasks import run_cron_worker, start_cron_scheduler
        threading.Thread(target=run_cron_worker, daemon=True, name="cron-worker").start()
        start_cron_scheduler()
        logger.info("cron-worker started (ROLE=cron)")
    logger.info("application startup complete")
    yield
    # Shutdown: close all persistent connections
    logger.info("application shutting down — closing connections")
    try:
        from app.discord import client as _disc
        _disc.close_discord_client()
    except Exception:
        pass
    try:
        from app.discord.http import _CoverClient
        _CoverClient.close()
    except Exception:
        pass
    try:
        from app.db import close_pool as _close_pool
        _close_pool()
    except Exception:
        pass
    try:
        from app.tasks import stop_worker as _stop_worker
        _stop_worker()
    except Exception:
        pass


app = FastAPI(
    title="manhwa-backend",
    version="1.0.0",
    description="Ikiru Bot manhwa scraper API. Use Bearer token for protected endpoints.",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# CORS: explicit allowlist for frontend origins (nginx also sets headers; this is defense-in-depth
# so a misconfigured reverse proxy cannot accidentally expose APIs to any origin).
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://fe.aldifhr.fun", "https://scanner.aldifhr.fun", "https://manhwa.aldifhr.fun"],
    allow_origin_regex=r"https://.*\.aldifhr\.fun",
    allow_methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["*", "X-CSRF-Token", "Authorization"],
    allow_credentials=True,
    max_age=600,
)

# Extracted middlewares (was inline 150L in god-file)
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
    import sys
    import uvicorn

    port = 3000
    if "--port" in sys.argv:
        idx = sys.argv.index("--port")
        if idx + 1 < len(sys.argv):
            port = int(sys.argv[idx + 1])
    # Single worker is enough for a personal server; the blocking DB paths
    # (public_stats/activity) now run via asyncio.to_thread so the loop is
    # never stalled. Behind Caddy, so proxy_headers=True for correct
    # X-Forwarded-* client IPs. uvloop (installed) for a faster event loop.
    # limit_max_requests recycles the worker periodically so any slow memory
    # leak (pool/cache) can't accumulate over days of uptime — PM2 restarts
    # the process when it exits.
    # 2026-08-30: changed host 0.0.0.0 -> 127.0.0.1. The app is always behind
    # Caddy (reverse_proxy localhost:3000), so binding to all interfaces only
    # exposed port 3000 to the public internet — causing uvicorn to log
    # "Invalid HTTP request received" from bots/probes that hit the raw port
    # with TLS/other-protocol bytes. Binding to loopback closes that surface;
    # Caddy still reaches it locally.
    # P1 PM2 cluster mode: workers=1 per PM2 instance (pm2 handles clustering, not uvicorn)
    # limit_max_requests removed in cluster mode - was killing BLPOP mid-job [tasks.py:373]
    # Use --limit-max-requests 0 so worker not recycled mid-BLPOP
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        workers=1,
        proxy_headers=True,
        forwarded_allow_ips="*",
        loop="uvloop",
        access_log=False,
        limit_concurrency=100,
        limit_max_requests=10000,
        timeout_keep_alive=30,
    )
