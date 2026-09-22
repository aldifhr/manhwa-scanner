"""FastAPI app (parity with lib/hono-app.ts + api/interactive.ts)."""
from contextlib import asynccontextmanager
import os
import threading

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger

logger = get_logger("hono-server")

from app.routers import register_routers

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: init resources. Shutdown: close connections gracefully."""
    # P1 fix: migration failure → fail startup (not silent warn)
    # Advisory lock prevents concurrent migration across multiple instances
    # Windows dev: skip hard migration when DB unreachable and ENVIRONMENT=development (VPS production tetap fail hard)
    from pathlib import Path
    import psycopg2
    dsn = os.getenv("DATABASE_URL") or "postgresql://be_ag:***@127.0.0.1:5432/be_ag_py"
    _is_dev = (os.getenv("ENVIRONMENT") or "production").lower() != "production"
    try:
        conn = psycopg2.connect(dsn)
    except Exception as e:
        if _is_dev:
            logger.warn("lifespan: DB unreachable in development — skip migration", err=str(e)[:200])
            conn = None  # type: ignore
        else:
            raise
    if conn is not None:
        conn.autocommit = False
        cur = conn.cursor()
        # Acquire advisory lock for migrations (only one instance migrates at a time)
        cur.execute("SELECT pg_advisory_lock(%s)", (1234567890,))
        cur.execute("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())")
        conn.commit()
        mig_dir = Path(__file__).parent / "db" / "migrations"
        try:
            for p in sorted(mig_dir.glob("*.sql")):
                cur.execute("SELECT 1 FROM schema_migrations WHERE filename=%s", (p.name,))
                if cur.fetchone():
                    continue
                try:
                    cur.execute(p.read_text())
                    cur.execute("INSERT INTO schema_migrations (filename) VALUES (%s)", (p.name,))
                    conn.commit()
                    logger.info("migrated", file=p.name)
                except Exception as e:
                    conn.rollback()
                    if _is_dev:
                        # Windows fresh DB: beberapa migrasi lama (010,016,etc) asumsi live schema dan fail di fresh install.
                        # Di dev, skip biar backend tetap bisa boot (VPS prod tetap fail hard di atas).
                        logger.warn("migrate failed — skipped in development", file=p.name, err=str(e)[:200])
                        # tandai sebagai applied biar gak retry terus
                        try:
                            cur.execute("INSERT INTO schema_migrations (filename) VALUES (%s) ON CONFLICT DO NOTHING", (p.name,))
                            conn.commit()
                        except Exception:
                            conn.rollback()
                        continue
                    logger.error("migrate failed — startup halted", file=p.name, err=str(e)[:200])
                    raise RuntimeError(f"migration {p.name} failed: {e}") from e
        finally:
            cur.execute("SELECT pg_advisory_unlock(%s)", (1234567890,))
        conn.close()
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
        from app.tasks import stop_worker as _stop_worker
        _stop_worker(timeout=10.0)
    except Exception:
        pass
    # Drain Redis processing lists before closing pool
    try:
        from app.tasks.queue import CRON_PROCESSING_KEY, QUEUE_PROCESSING_KEY, _get_redis
        r = _get_redis()
        for key in (CRON_PROCESSING_KEY, QUEUE_PROCESSING_KEY):
            while True:
                raw = r.rpop(key)
                if raw is None:
                    break
                r.lpush(key.replace(":processing", ""), raw)  # type: ignore[arg-type]
    except Exception:
        pass
    try:
        from app.db import close_pool as _close_pool
        _close_pool()
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

# CORS: explicit allowlist — P1 fix: no wildcard regex
# Windows dev: tambahkan localhost biar FE lokal bisa hit BE lokal tanpa ubah VPS (VPS tetap strict, dev dapat localhost)
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

_cors_origins = ["https://scanner.aldifhr.fun", "https://manhwa.aldifhr.fun"]
if (os.getenv("ENVIRONMENT") or "production").lower() != "production":
    _cors_origins += [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["*", "X-CSRF-Token", "Authorization"],
    allow_credentials=True,
    max_age=600,
)

# Boot config validation — fail fast on missing critical settings
try:
    from app.boot_config import validate_settings
    validate_settings()
except RuntimeError as e:
    import sys as _sys
    print(f"FATAL: {e}", file=_sys.stderr)
    _sys.exit(1)

# Graceful shutdown — finish current job, close connections
from app.services.graceful_shutdown import install_signal_handlers, register_shutdown_handler
install_signal_handlers()

# Extracted middlewares (was inline 150L in god-file)
from app.middleware.correlation import correlation_middleware
from app.middleware.security import security_headers_middleware
from app.middleware.access_log import access_log_middleware
app.middleware("http")(correlation_middleware)
app.middleware("http")(security_headers_middleware)
app.middleware("http")(access_log_middleware)

from app.utils.request_auth import require_monitor_auth

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
    return JSONResponse(content=custom_openapi(app))

# --- Uniform JSON error responses (no HTML leaks to the FE) ---
from fastapi import HTTPException as _HTTPException
from fastapi.exceptions import RequestValidationError as _RequestValidationError
from starlette.exceptions import HTTPException as _StarletteHTTPException

@app.exception_handler(_HTTPException)
@app.exception_handler(_StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: _HTTPException):
    _CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden",
              404: "not_found", 500: "internal_error"}
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

    signature = request.headers.get("x-signature-ed25519", "") or request.headers.get("X-Signature-Ed25519", "")
    timestamp = request.headers.get("x-signature-timestamp", "") or request.headers.get("X-Signature-Timestamp", "")
    body = await request.body()

    if not _disc.verify_interaction_v2(body, signature, timestamp):
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
    # Windows tidak punya uvloop (hanya Linux/macOS) — fallback ke asyncio biar VPS tetap uvloop
    import sys as _sys
    import importlib.util as _ilu
    _loop = "uvloop" if (_ilu.find_spec("uvloop") is not None and _sys.platform != "win32") else "auto"
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        workers=1,
        proxy_headers=True,
        forwarded_allow_ips="*",
        loop=_loop,  # type: ignore[arg-type]
        access_log=False,
        limit_concurrency=100,
        limit_max_requests=10000,
        timeout_keep_alive=30,
    )
