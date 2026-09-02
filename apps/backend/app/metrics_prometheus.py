"""Prometheus metrics for observability."""
from prometheus_client import Counter, Histogram, Gauge, Info, generate_latest, CONTENT_TYPE_LATEST
from fastapi import Response

# ── Request Metrics ──

REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"]
)

REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency",
    ["method", "endpoint"],
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
)

# ── Business Metrics ──

RSS_FETCH_COUNT = Counter(
    "rss_fetch_total",
    "Total RSS fetches",
    ["source"]
)

RSS_FETCH_ERRORS = Counter(
    "rss_fetch_errors_total",
    "RSS fetch errors",
    ["source", "error_type"]
)

RSS_ITEMS_FETCHED = Histogram(
    "rss_items_fetched",
    "Items fetched per source",
    ["source"],
    buckets=[1, 5, 10, 25, 50, 100, 250, 500, 1000]
)

DISPATCH_SENT = Counter(
    "dispatch_sent_total",
    "Total Discord notifications sent",
    ["source", "status"]
)

DISPATCH_LATENCY = Histogram(
    "dispatch_duration_seconds",
    "Discord notification latency",
    ["source"],
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0]
)

DISPATCH_ERRORS = Counter(
    "dispatch_errors_total",
    "Discord notification errors",
    ["error_type"]
)

# ── System Metrics ──

ACTIVE_JOBS = Gauge(
    "active_jobs",
    "Currently running cron jobs",
    ["job_type"]
)

CIRCUIT_BREAKER_STATE = Gauge(
    "circuit_breaker_state",
    "Circuit breaker state (0=closed, 1=half-open, 2=open)",
    ["service"]
)

DB_POOL_SIZE = Gauge(
    "db_pool_connections",
    "DB connection pool size",
    ["state"]  # active, idle
)

APP_INFO = Info(
    "app_info",
    "Application information"
)


def track_request(method: str, endpoint: str, status: int, duration: float):
    """Record request metrics."""
    REQUEST_COUNT.labels(method=method, endpoint=endpoint, status=status).inc()
    REQUEST_LATENCY.labels(method=method, endpoint=endpoint).observe(duration)


def track_rss_fetch(source: str, item_count: int, error: str = None):
    """Track RSS fetch."""
    if error:
        RSS_FETCH_ERRORS.labels(source=source, error_type=error).inc()
    else:
        RSS_FETCH_COUNT.labels(source=source).inc()
        RSS_ITEMS_FETCHED.labels(source=source).observe(item_count)


def track_dispatch(source: str, status: str, duration: float):
    """Track dispatch."""
    DISPATCH_SENT.labels(source=source, status=status).inc()
    DISPATCH_LATENCY.labels(source=source).observe(duration)


def track_dispatch_error(error_type: str):
    """Track dispatch error."""
    DISPATCH_ERRORS.labels(error_type=error_type).inc()


def get_metrics():
    """Generate Prometheus metrics output."""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )
