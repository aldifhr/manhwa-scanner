"""Auth helpers for monitor/cron endpoints.

Uses constant-time comparison (hmac.compare_digest) to avoid timing attacks
on the bearer token. Token is configured via CRON_SECRET / MONITOR_AUTH_TOKEN.
"""
from __future__ import annotations

import hmac

from app.config import settings
from app.logger import get_logger

logger = get_logger("utils:auth")


def token_matches(provided: str, *, role: str = "both") -> bool:
    """Return True if `provided` matches a configured secret (constant-time).

    `role` restricts WHICH secret is allowed:
      - "cron"    → only CRON_SECRET (cron's ?token= secret)
      - "monitor" → only MONITOR_AUTH_TOKEN (dashboard JWT / Bearer)
      - "both"    → either (legacy callers that don't distinguish)

    SECURITY: previously CRON_SECRET and MONITOR_AUTH_TOKEN were
    treated as interchangeable "candidates" — so the query-string
    CRON_SECRET (the one most exposed to access logs / referrers)
    had EQUAL privilege to the dashboard token (could CRUD
    whitelist, delete dispatches). They are now SEPARATE roles.
    Endpoints that mutate state (whitelist write, dispatch delete)
    must require the "monitor" role, never "cron".
    """
    if not provided:
        return False
    if role == "cron":
        candidates = [c for c in (settings.CRON_SECRET) if c]
    elif role == "monitor":
        candidates = [settings.MONITOR_AUTH_TOKEN]
    else:  # both (legacy)
        candidates = [s for s in (settings.CRON_SECRET, settings.MONITOR_AUTH_TOKEN) if s]
    candidates = [c for c in candidates if c]
    if not candidates:
        return False
    # SECURITY: constant-time compare requires str. Non-ASCII would raise
    # TypeError → leak 500 oracle. Normalize to str safely.
    if not isinstance(provided, str):
        return False
    provided = provided.strip()
    if not provided:
        return False
    return any(hmac.compare_digest(provided, str(c)) for c in candidates)


def cron_token_matches(provided: str) -> bool:
    return token_matches(provided, role="cron")


def monitor_token_matches(provided: str) -> bool:
    return token_matches(provided, role="monitor")


def check_monitor_auth(authorization: str = "", token_param: str = "", cookie: str = "") -> bool:
    """Check Bearer header OR ?token= query param OR session cookie (JWT).

    The FE proxy forwards the `ikiru_dashboard_session` JWT cookie set by
    /api/auth, so we must also accept it here (decoded + exp-checked).

    MONITOR role ONLY — uses MONITOR_AUTH_TOKEN (never CRON_SECRET).
    State-mutating dashboard endpoints (whitelist write, dispatch
    delete) route through here so the query-string CRON_SECRET
    (most-exposed secret) can NEVER exercise them.
    """
    # Explicit dev override only — and NEVER allowed in production.
    if getattr(settings, "AUTH_DISABLED", False):
        # AUTH_DISABLED fully bypasses all auth. Reject it in production so a
        # stray `AUTH_DISABLED=true` in any env can never expose the API.
        if getattr(settings, "ENVIRONMENT", "production").lower() == "production":
            logger.warn("AUTH_DISABLED=true ignored in production (auth enforced)")
        else:
            return True
    # Auth required: no secret configured → unsatisfiable (fail closed).
    if not settings.MONITOR_AUTH_TOKEN:
        return False
    # Bearer header
    if authorization and authorization.lower().startswith("bearer "):
        if monitor_token_matches(authorization[7:].strip()):
            return True
    # ?token= query param (monitor role only)
    if token_param and monitor_token_matches(token_param):
        return True
    # Session cookie (JWT issued by /api/auth). Decode + verify exp.
    if cookie:
        import jwt as _jwt
        try:
            secret = settings.AUTH_SECRET
            if not secret:
                return False
            _jwt.decode(cookie, secret, algorithms=["HS256"])
            return True
        except Exception:
            return False
    return False


def role_from_request(authorization: str = "", token_param: str = "", cookie: str = "") -> str | None:
    """Resolve the caller's role from a valid monitor credential.

    Returns "admin" | "member" | None. Used by write-limited endpoints to
    allow members (add whitelist / exclude) while reserving destructive
    actions (delete / retry / clear / settings) for admins.
    """
    # Bearer / ?token= monitor secret → admin (those secrets are the admin one)
    if authorization and authorization.lower().startswith("bearer "):
        if monitor_token_matches(authorization[7:].strip()):
            return "admin"
    if token_param and monitor_token_matches(token_param):
        return "admin"
    # JWT session cookie carries the `role` claim.
    if cookie:
        from app.api.auth import role_from_jwt
        r = role_from_jwt(cookie)
        if r in ("admin", "member"):
            return r
    return None


def require_role(allowed: set[str], authorization: str = "", token_param: str = "", cookie: str = "") -> bool:
    """True if the caller is authenticated AND has an allowed role.

    `allowed` examples:
      {"admin"}            → admins only (delete / retry / clear / settings)
      {"admin", "member"}  → write-limited (add whitelist / exclude)
    """
    if not check_monitor_auth(authorization, token_param, cookie):
        return False
    role = role_from_request(authorization, token_param, cookie)
    if role is None:
        # Authenticated via a path we didn't map to a role → treat as admin
        # only if a monitor secret was used (Bearer/?token=), else deny.
        return "admin" in allowed and bool(authorization or token_param)
    return role in allowed


def check_cron_auth(token_param: str = "") -> bool:
    """Auth for the /api/cron trigger — CRON_SECRET ONLY.

    This is a SEPARATE role from the dashboard: external cron hits
    /api/cron?token=CRON_SECRET. The CRON_SECRET is the most-exposed
    secret (it lives in a query string, visible to access logs / referrers),
    so it must NOT grant dashboard/CRUD privileges. We accept ONLY
    CRON_SECRET here, never MONITOR_AUTH_TOKEN.
    """
    if getattr(settings, "AUTH_DISABLED", False):
        if getattr(settings, "ENVIRONMENT", "production").lower() == "production":
            logger.warn("AUTH_DISABLED=true ignored in production (auth enforced)")
        else:
            return True
    if not settings.CRON_SECRET:
        return False
    return cron_token_matches(token_param)
