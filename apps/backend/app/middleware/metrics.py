"""Prometheus metrics middleware."""
from fastapi import Request


async def metrics_middleware(request: Request, call_next):
    import time
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start
    if request.url.path not in ("/metrics", "/healthz"):
        try:
            from app.metrics_prometheus import track_request
            track_request(method=request.method, endpoint=request.url.path, status=response.status_code, duration=duration)
        except Exception:
            pass
    return response
