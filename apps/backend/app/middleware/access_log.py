"""Access log middleware — real-time request/response logging."""
import time

from fastapi import Request

from app.logger import get_logger

logger = get_logger("http")


async def access_log_middleware(request: Request, call_next):
    t0 = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        raise
    dt = (time.monotonic() - t0) * 1000
    logger.info(
        "access",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        ms=round(dt, 1),
        ip=request.client.host if request.client else None,
    )
    return response
