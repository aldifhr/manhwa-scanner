"""Shared request-auth + query-param helpers for API routers."""

from fastapi import Request
from app.utils.auth import check_monitor_auth


def require_monitor_auth(request: Request) -> bool:
    return check_monitor_auth(
        request.headers.get("authorization", ""),
        request.query_params.get("token", ""),
        cookie=request.cookies.get("ikiru_dashboard_session", ""),
    )


def get_session_hash(request: Request) -> str | None:
    """Return a stable per-session hash for continue-reading storage.
    
    Uses the ikiru_dashboard_session cookie (JWT) — sha256[:16].
    Falls back to Authorization Bearer <REDACTED>
    """
    import hashlib as _hashlib
    
    cookie = request.cookies.get("ikiru_dashboard_session", "")
    if cookie:
        return _hashlib.sha256(cookie.encode()).hexdigest()[:16]
    
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
        if token and token != "null":
            return _hashlib.sha256(token.encode()).hexdigest()[:16]
    
    return None


def require_cron_auth(request: Request) -> bool:
    from app.utils.auth import check_cron_auth

    # Support both ?token= and ?key= (FastCron uses ?key=) — both deprecated, Bearer preferred
    token_q = request.query_params.get("token", "") or request.query_params.get("key", "")
    return check_cron_auth(
        token_q,
        authorization=request.headers.get("authorization", ""),
    )



def int_safe(value: str | None, default: int = 0, max_val: int | None = None) -> int:
    if value is None:
        return default
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    if max_val is not None and n > max_val:
        return max_val
    if n < 0:
        return default
    return n


def safe_error(e: Exception, message: str = "internal server error") -> dict:
    try:
        from app.metrics import inc

        inc("errors_500")
    except Exception:
        pass
    return {"success": False, "error": message}
