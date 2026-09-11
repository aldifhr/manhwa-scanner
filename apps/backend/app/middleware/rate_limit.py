"""In-memory rate limiter — per-IP, per-minute, no external deps."""
import time

from fastapi import Request
from fastapi.responses import JSONResponse

# ponytail: in-memory dict, global lock — single-process only, resets on restart
# Memory bounded by unique IPs × 1 minute bucket; lazy cleanup at 50k entries.
_counts: dict[tuple[str, int], int] = {}


async def rate_limit_middleware(request: Request, call_next):
    ip = request.client.host if request.client else "?"
    minute = int(time.time()) // 60
    # Auth endpoints (login/refresh) get stricter limit — P1 fix: 5/min (was 100/min)
    path = request.url.path
    is_auth = path.endswith("/auth") or "/auth/" in path
    limit = 5 if is_auth else 1000

    key = (ip, minute)
    count = _counts.get(key, 0) + 1
    _counts[key] = count

    if len(_counts) > 50000:
        _counts.clear()

    if count > limit:
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "message": f"Rate limit exceeded ({limit}/min)"},
        )

    return await call_next(request)
