"""Correlation ID middleware — sets X-Request-Id -> logger cid."""
from fastapi import Request
import uuid

from app.logger import set_correlation_id


async def correlation_middleware(request: Request, call_next):
    cid = request.headers.get("x-request-id") or request.headers.get("x-correlation-id") or uuid.uuid4().hex[:16]
    set_correlation_id(cid)
    response = await call_next(request)
    response.headers["X-Request-Id"] = cid
    return response
