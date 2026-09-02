"""Shared request-auth + query-param helpers for API routers."""

from fastapi import Request

from app.utils.auth import check_monitor_auth, role_from_request


def require_monitor_auth(request: Request) -> bool:
    """Return True if the request is authenticated for monitor/cron endpoints.

    Checks the Bearer header OR the ?token= query param OR the
    `ikiru_dashboard_session` JWT session cookie (forwarded by the FE
    proxy from the browser's login session).
    """
    return check_monitor_auth(
        request.headers.get("authorization", ""),
        request.query_params.get("token", ""),
        cookie=request.cookies.get("ikiru_dashboard_session", ""),
    )


def require_cron_auth(request: Request) -> bool:
    """Return True if request carries a valid CRON_SECRET (cron role ONLY)."""
    from app.utils.auth import check_cron_auth
    return check_cron_auth(request.query_params.get("token", ""))


def require_role_auth(request: Request, allowed: set[str]) -> bool:
    """Role-gated auth for write endpoints.

    `allowed` is the set of roles permitted, e.g.:
      {"admin"}            → destructive actions (delete / retry / clear)
      {"admin", "member"}  → write-limited (add whitelist / exclude)
    Returns False (→ caller returns 401) when unauthenticated or role not allowed.
    """
    authorization = request.headers.get("authorization", "")
    token_param = request.query_params.get("token", "")
    cookie = request.cookies.get("ikiru_dashboard_session", "")
    if not check_monitor_auth(authorization, token_param, cookie=cookie):
        return False
    role = role_from_request(authorization, token_param, cookie=cookie)
    if role is None:
        # Authenticated via a path with no role mapping (legacy Bearer/?token=
        # admin secret) → treat as admin only when an admin secret was used.
        return "admin" in allowed and bool(authorization or token_param)
    return role in allowed


def int_safe(value: str | None, default: int = 0, max_val: int | None = None) -> int:
    """Parse an int from a query param without throwing on bad input.

    Returns `default` if the value is missing or not a valid integer.
    Clamps to `max_val` when provided (e.g. cap page_size at 200).
    """
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
    """Build a generic error payload that does NOT leak internal exception text.

    The full exception is logged by the caller's logger; the client only sees a
    generic message so we don't expose stack traces / SQL errors / internal paths.
    """
    try:
        from app.metrics import inc
        inc("errors_500")
    except Exception:
        pass
    return {"success": False, "error": message}
