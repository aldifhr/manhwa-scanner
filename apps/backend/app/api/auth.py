"""Auth endpoint: POST /api/auth?action=login|refresh.

Sets the `ikiru_dashboard_session` JWT cookie used by the FE gate and
forwarded to monitor/cron endpoints. Password is validated against
MONITOR_AUTH_TOKEN (the same secret used for ?token= auth).

Actions:
  - login   : password -> issue JWT (admin/member role)
  - refresh : valid dashboard JWT cookie -> re-issue JWT (exp +7d)
               no/invalid/expired cookie -> 401 (never 400)
"""
from __future__ import annotations

import hmac
import secrets as _secrets
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import jwt as _jwt

from app.config import settings

router = APIRouter()

_COOKIE_SESSION = "ikiru_dashboard_session"
_COOKIE_CSRF = "ikiru_csrf_token"
_COOKIE_MAX_AGE = 7 * 24 * 60 * 60


def _issue_jwt(role: str = "admin") -> str:
    secret = settings.AUTH_SECRET
    if not secret:
        raise RuntimeError("AUTH_SECRET not configured")
    exp = int(time.time()) + _COOKIE_MAX_AGE  # 7 days
    return _jwt.encode(
        {"sub": "dashboard", "role": role, "exp": exp, "iat": int(time.time())},
        secret,
        algorithm="HS256",
    )


def role_from_jwt(token: str) -> str | None:
    """Decode the dashboard session JWT and return its `role` claim, or None."""
    secret = settings.AUTH_SECRET
    if not secret or not token:
        return None
    try:
        payload = _jwt.decode(token, secret, algorithms=["HS256"])
        return payload.get("role")
    except Exception:
        return None


def _get_session_cookie(request: Request) -> str | None:
    """Return the dashboard session JWT from cookie (preferred) or Bearer header."""
    cookie = request.cookies.get(_COOKIE_SESSION)
    if cookie:
        return cookie
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _set_session_cookies(resp: JSONResponse, token: str) -> None:
    resp.set_cookie(
        key=_COOKIE_SESSION,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",  # FE is on a different host; Lax allows top-level navigation
        path="/",
        max_age=_COOKIE_MAX_AGE,
    )
    # CSRF defense: set a readable (non-httponly) cookie so the FE can
    # echo it back as a header on mutating requests (double-submit pattern).
    # Middleware validates it on write methods.
    csrf_token = _secrets.token_urlsafe(32)
    resp.set_cookie(
        key=_COOKIE_CSRF,
        value=csrf_token,
        httponly=False,  # FE JS must read this to send X-CSRF-Token header
        secure=True,
        samesite="lax",
        path="/",
        max_age=_COOKIE_MAX_AGE,
    )


@router.post("/auth")
async def auth_handler(request: Request):
    action = request.query_params.get("action", "login")

    # ---- Refresh: verify existing JWT, re-issue ----
    # Excluded from brute-force guard (requires valid JWT, not a password guess).
    if action == "refresh":
        token = _get_session_cookie(request)
        if not token:
            return JSONResponse(
                {"success": False, "error": "unauthorized"}, status_code=401
            )
        role = role_from_jwt(token)
        if not role:
            return JSONResponse(
                {"success": False, "error": "unauthorized"}, status_code=401
            )
        new_token = _issue_jwt(role)
        resp = JSONResponse({"success": True, "data": {"ok": True}})
        _set_session_cookies(resp, new_token)
        return resp

    # ---- Login: password -> JWT ----
    if action != "login":
        return JSONResponse({"success": False, "error": "Unknown action"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid body"}, status_code=400)

    password = body.get("password", "") if isinstance(body, dict) else ""
    if not password:
        return JSONResponse({"success": False, "error": "Invalid credentials"}, status_code=401)

    # Two roles: admin (MONITOR_AUTH_TOKEN) and member (MEMBER_AUTH_TOKEN).
    role = None
    if settings.MONITOR_AUTH_TOKEN and hmac.compare_digest(password, settings.MONITOR_AUTH_TOKEN):
        role = "admin"
    elif settings.MEMBER_AUTH_TOKEN and hmac.compare_digest(password, settings.MEMBER_AUTH_TOKEN):
        role = "member"
    if not role:
        return JSONResponse({"success": False, "error": "Invalid credentials"}, status_code=401)

    token = _issue_jwt(role)
    resp = JSONResponse({"success": True, "data": {"ok": True, "role": role}})
    _set_session_cookies(resp, token)
    return resp


# Discord OAuth login has been removed.
