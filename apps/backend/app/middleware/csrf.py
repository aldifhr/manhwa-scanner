"""CSRF middleware — bypassed entirely (admin API uses token/cookie auth)."""
from fastapi import Request


async def csrf_middleware(request: Request, call_next):
    return await call_next(request)
