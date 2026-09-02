"""FastAPI app (parity with lib/hono-app.ts + api/interactive.ts)."""
from contextlib import asynccontextmanager
import os
import threading

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.logger import get_logger

logger = get_logger("hono-server")

from app.api import dashboard as dashboard_api
from app.api import catalog as catalog_api
from app.api import auth as auth_api
from app.api import dispatches as dispatches_api
from app.api import observability as observability_api
from app.api import system as system_api
from app.api import rss as rss_api
from app.api import settings as settings_api
from app.api import activity as activity_api
from app.api import public_stats as public_stats_api
from app.api import continue_reading as continue_reading_api
from fastapi.openapi.utils import get_openapi


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


# --- Health/readiness probe (PM2 + gateway liveness check) ---
@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "be-ag-py"}


# Root: redirect to the FE dashboard (people hitting the API domain directly).
@app.get("/", include_in_schema=False)
async def root_redirect():
    from fastapi.responses import RedirectResponse
    fe = str(settings.PUBLIC_BASE_URL or "").strip()
    # PUBLIC_BASE_URL points at this API in prod config; FE is a separate host.
    target = "https://manhwa.aldifhr.fun/"
    if fe and "scanner.aldifhr.fun" not in fe:
        target = fe if fe.startswith("http") else f"https://{fe}/"
    return RedirectResponse(target, status_code=302)


# --- Aggregate health: per-source status, last scrape, pending, error rate ---
@app.get("/api/v1/health")
async def api_health(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        from app.config import settings as _s
        from app.storage import health as _h
        from app.db import get_supabase as _gsb

        hm = _h.load_source_health_map(_s.SOURCE_KEYS)
        sources = []
        for src, row in (hm or {}).items():
            ok_24h = int(row.get("successes_today") or 0) + int(row.get("failures_today") or 0)
            err_rate = round(100.0 * int(row.get("failures_today") or 0) / ok_24h, 1) if ok_24h else 0.0
            sources.append({
                "name": src,
                "status": row.get("status", "healthy"),
                "lastScrape": row.get("last_checked_at") or "",
                "lastSuccess": row.get("last_success_at") or "",
                "errorRate24h": err_rate,
                "consecutiveFailures": row.get("consecutive_failures") or 0,
                "lastError": row.get("last_error"),
                "disabledUntil": row.get("disabled_until"),
            })

        # Pending = recent chapters not yet in dispatch_history (the queue
        # the dispatcher still has to send) within the last 24h.
        pending = 0
        try:
            from app.storage import recent_chapters as _rc
            rows = _rc._fetch_recent_rows(hours=24, limit=2000, offset=0)
            urls = [r.get("chapter_url") for r in rows if r.get("chapter_url")]
            if urls:
                _dh = _gsb().table("dispatch_history").select("chapter_url").in_("chapter_url", urls).execute()
                sent_urls = {r["chapter_url"] for r in (_dh.data or [])}
                pending = sum(1 for u in urls if u not in sent_urls)
        except Exception:
            pending = -1
        return JSONResponse(content={
            "success": True,
            "data": {
                "sources": sources,
                "pending": pending,
                "lastScrapeAt": max((s["lastScrape"] for s in sources), default=""),
                "service": "be-ag-py",
            },
        })
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


from app.utils.request_auth import safe_error, require_monitor_auth


# --- CSRF defense ---
# Double-submit cookie pattern. FE sends X-CSRF-Token header on mutating requests.
# Whitelisted endpoints (no CSRF check): auth (user has no token yet),
# Discord webhook (separately signed), cron (server-side, signed).
# Note: Bearer token-authenticated requests are already exempt (line ~167).
_CSRF_WHITELIST = {"/api/v1/auth", "/api/v1/interactive", "/api/v1/cron"}


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    """Track Prometheus metrics for all requests."""
    import time
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start
    
    # Track metrics (skip /metrics and /healthz to avoid self-instrumentation)
    if request.url.path not in ("/metrics", "/healthz"):
        try:
            from app.metrics_prometheus import track_request
            track_request(
                method=request.method,
                endpoint=request.url.path,
                status=response.status_code,
                duration=duration,
            )
        except Exception:
            pass
    
    return response


@app.middleware("http")
async def csrf_middleware(request: Request, call_next):
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        # Bearer token proves non-browser origin — exempt from double-submit CSRF.
        if request.headers.get("authorization", "").lower().startswith("bearer "):
            return await call_next(request)
        # Whitelist exact + trailing-slash tolerant (proxy may add "/")
        _path = request.url.path.rstrip("/")
        if _path in {p.rstrip("/") for p in _CSRF_WHITELIST}:
            return await call_next(request)
        cookie_token = request.cookies.get("ikiru_csrf_token", "")
        header_token = request.headers.get("x-csrf-token", "")
        if not cookie_token or not header_token or cookie_token != header_token:
            return JSONResponse(
                content={"success": False, "error": "CSRF validation failed"},
                status_code=403,
            )
    return await call_next(request)


# --- Security headers (defense in depth; nginx also sets some) ---
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "img-src 'self' data: https:; "
        "connect-src 'self' https://scanner.aldifhr.fun https://fe.aldifhr.fun; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'"
    ),
    "X-Frame-Options": "DENY",
}


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    for k, v in _SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    return response


# --- OpenAPI ---
app.openapi_schema = None


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title="manhwa-backend",
        version="1.0.0",
        description=(
            "Ikiru Bot manhwa scraper API. "
            "Backend runs fully on local VPS Postgres (no Supabase). "
            "Use Bearer token for protected endpoints."
        ),
        routes=app.routes,
    )
    schema["servers"] = [{"url": "https://scanner.aldifhr.fun", "description": "Production (VPS)"}]
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["BearerAuth"] = {
        "type": "http",
        "scheme": "bearer",
    }
    for path in schema.get("paths", {}).values():
        for method in path.values():
            method.setdefault("security", [{"BearerAuth": []}])
    # Add query params for paginated whitelist endpoints (read from
    # request.query_params, so they don't appear in the auto-generated schema).
    _wl_params = [
        {
            "name": "page",
            "in": "query",
            "required": False,
            "schema": {"type": "integer", "default": 1, "minimum": 1},
            "description": "Page number (1-based).",
        },
        {
            "name": "page_size",
            "in": "query",
            "required": False,
            "schema": {"type": "integer", "default": 100, "minimum": 1, "maximum": 10000},
            "description": "Rows per page (1..10000).",
        },
        {
            "name": "source",
            "in": "query",
            "required": False,
            "schema": {"type": "string", "enum": ["ikiru", "shinigami", "voratoon"]},
            "description": "Filter by source.",
        },
        {
            "name": "title",
            "in": "query",
            "required": False,
            "schema": {"type": "string"},
            "description": "Case-insensitive title search.",
        },
        {
            "name": "cursor",
            "in": "query",
            "required": False,
            "schema": {"type": "string"},
            "description": "Keyset cursor (created_at ISO) for pagination — preferred over page for large tables.",
        },
    ]
    for _p in ("/api/v1/whitelist", "/api/v1/reader/whitelist"):
        _ep = schema.get("paths", {}).get(_p, {}).get("get")
        if _ep is not None:
            _ep["parameters"] = _wl_params
    app.openapi_schema = schema
    return schema


app.openapi = custom_openapi

# --- Backward compatibility: redirect legacy /api/ to /api/v1/ (MUST be before routers) ---
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
    "/api/redirect/chapter": "/api/v1/redirect/chapter",
}

@app.middleware("http")
async def legacy_redirect_middleware(request: Request, call_next):
    """Redirect legacy /api/* paths to /api/v1/*."""
    path = request.url.path
    if path in _LEGACY_REDIRECTS:
        from fastapi.responses import RedirectResponse
        qs = str(request.query_params)
        url = _LEGACY_REDIRECTS[path] + (f"?{qs}" if qs else "")
        return RedirectResponse(url=url, status_code=307)
    return await call_next(request)

# --- Router includes ---
app.include_router(dashboard_api.router, prefix="/api/v1")
app.include_router(catalog_api.router, prefix="/api/v1")
app.include_router(auth_api.router, prefix="/api/v1")
app.include_router(dispatches_api.router, prefix="/api/v1")
app.include_router(observability_api.router, prefix="/api/v1")
app.include_router(rss_api.router, prefix="/api/v1")
from app.api.cron_status import router as _cron_status_router  # noqa: E402

app.include_router(_cron_status_router, prefix="/api/v1")
app.include_router(system_api.router, prefix="/api/v1")

# --- Web settings (per-guild notification config) ---
from fastapi import APIRouter as _AR
_settings_router = _AR()

@_settings_router.get("/settings")
async def _settings_get(request: Request):
    return await settings_api.settings_get(request)

@_settings_router.put("/settings/{guild_id}")
async def _settings_put(request: Request, guild_id: str):
    return await settings_api.settings_put(request, guild_id)

app.include_router(_settings_router, prefix="/api/v1")

# --- Activity heatmap (public aggregate) ---
app.include_router(activity_api.router, prefix="/api/v1")

# --- Analytics dashboard ---
from app.api import analytics as analytics_api
from app.api import reading_stats as reading_stats_api
app.include_router(analytics_api.router, prefix="/api/v1")
app.include_router(reading_stats_api.router, prefix="/api/v1")

# --- Custom RSS feed with advanced filters ---
from app.api import rss_custom as rss_custom_api
app.include_router(rss_custom_api.router, prefix="/api/v1")

# --- Public stats (portfolio/showcase aggregate) ---
app.include_router(public_stats_api.router, prefix="/api/v1")
app.include_router(continue_reading_api.router, prefix="/api/v1")

# --- Bookmark API ---
from app.api import bookmark as bookmark_api
app.include_router(bookmark_api.router)

# --- WebSocket ---
from app.api.websocket import router as websocket_router
app.include_router(websocket_router)

# --- Whitelist (dispatch-history) ---
from app.api.dashboard import whitelist as whitelist_api
app.include_router(whitelist_api.router, prefix="/api/v1")

# --- Queue dashboard ---
from app.api import queue_dashboard as queue_dashboard_api
app.include_router(queue_dashboard_api.router)

# --- Prometheus metrics endpoint ---
@app.get("/metrics")
async def metrics_root():
    from app.metrics_prometheus import get_metrics
    return get_metrics()

# --- Detailed health with circuit breakers ---
@app.get("/api/v1/health/detailed")
async def health_detailed_v1():
    """Detailed health with source status, circuit breakers, uptime."""
    from app.services.resilience import cb_discord, cb_db, cb_ikiru, cb_shinigami, cb_voratoon
    from app.db import get_pool_stats
    from app.storage import health as health_store
    from app.config import settings
    try:
        pool = get_pool_stats()
    except Exception:
        pool = {"active": -1, "idle": -1}
    
    # Get source health
    hm = health_store.load_source_health_map(settings.SOURCE_KEYS)
    sources = []
    for src, row in (hm or {}).items():
        ok_24h = int(row.get("successes_today") or 0) + int(row.get("failures_today") or 0)
        err_rate = round(100.0 * int(row.get("failures_today") or 0) / ok_24h, 1) if ok_24h else 0.0
        sources.append({
            "name": src,
            "status": row.get("status", "healthy"),
            "lastScrape": row.get("last_checked_at") or "",
            "lastSuccess": row.get("last_success_at") or "",
            "errorRate24h": err_rate,
            "consecutiveFailures": row.get("consecutive_failures") or 0,
            "lastError": row.get("last_error"),
            "disabledUntil": row.get("disabled_until"),
        })
    
    # Overall status
    down_count = sum(1 for s in sources if s["status"] == "down")
    degraded_count = sum(1 for s in sources if s["status"] == "degraded")
    overall = "down" if down_count > 0 else ("degraded" if degraded_count > 0 else "healthy")
    
    import time as _t_up
    _uptime_s = _t_up.time() - health_store.APP_START_TS if hasattr(health_store, "APP_START_TS") else 0
    if not _uptime_s:
        try:
            from app.api.observability import APP_START_TS as _api_start
            _uptime_s = _t_up.time() - _api_start
        except Exception:
            _uptime_s = 0
    # uptime % = SLA: 100 - errorRate avg, but for personal VPS keep 99.9 placeholder unless degraded
    _avg_err = sum(s["errorRate24h"] for s in sources) / len(sources) if sources else 0
    _uptime_pct = round(100 - _avg_err, 1) if sources else 99.9
    if _uptime_pct < 99.0:
        _uptime_pct = 99.0  # floor for display
    return {
        "success": True,
        "data": {
            "sources": sources,
            "overall": overall,
            "uptime": _uptime_pct,
            "uptime_human": f"{int(_uptime_s//3600)}h {int((_uptime_s%3600)//60)}m" if _uptime_s else "0m",
            "version": "1.0.0",
            "circuit_breakers": {
                "discord": cb_discord.state.value,
                "db": cb_db.state.value,
                "ikiru": cb_ikiru.state.value,
                "shinigami": cb_shinigami.state.value,
                "voratoon": cb_voratoon.state.value,
            },
            "db_pool": pool,
        }
    }

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
