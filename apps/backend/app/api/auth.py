"""Auth endpoint: POST /api/auth?action=login|refresh.

Single shared password `manhwascan` (or DASHBOARD_PASSWORD env) — no admin/member roles.
Sets the `manhwa_dashboard_session` JWT cookie used by the FE gate.
"""

from __future__ import annotations

import hmac
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

import jwt as _jwt

from app.config import settings

class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(..., min_length=1, max_length=200)

router = APIRouter()

from app.utils.cookies import (
    CSRF_COOKIE as _COOKIE_CSRF,
    SESSION_COOKIE as _COOKIE_SESSION,
    _LEGACY_CSRF_COOKIE,
    _LEGACY_ROLE_COOKIE,
)

_COOKIE_MAX_AGE = 60 * 60 * 24 * 30
_COOKIE_MAX_AGE = 7 * 24 * 60 * 60

def _issue_jwt() -> str:
    secret = settings.AUTH_SECRET
    if not secret:
        raise RuntimeError("AUTH_SECRET not configured")
    exp = int(time.time()) + _COOKIE_MAX_AGE
    return _jwt.encode(
        {"sub": "dashboard", "exp": exp, "iat": int(time.time())},
        secret,
        algorithm="HS256",
    )

def role_from_jwt(token: str) -> str | None:
    """Compat shim — always returns 'user' for valid JWT, None otherwise."""
    secret = settings.AUTH_SECRET
    if not secret or not token:
        return None
    try:
        _jwt.decode(token, secret, algorithms=["HS256"])
        return "user"
    except Exception:
        return None

def _get_session_cookie(request: Request) -> str | None:
    cookie = request.cookies.get(_COOKIE_SESSION)
    if cookie:
        return cookie
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None

def _set_session_cookies(resp: JSONResponse, token: str) -> None:
    import secrets as _secrets

    resp.set_cookie(
        key=_COOKIE_SESSION,
        value=token,
        httponly=True,
        secure=True,
        samesite="none",
        domain=".aldifhr.my.id",
        path="/",
        max_age=_COOKIE_MAX_AGE,
    )
    csrf_token = _secrets.token_urlsafe(32)
    resp.set_cookie(
        key=_COOKIE_CSRF,
        value=csrf_token,
        httponly=False,
        secure=True,
        samesite="none",
        domain=".aldifhr.my.id",
        path="/",
        max_age=_COOKIE_MAX_AGE,
    )
    # Clear the pre-rename cookies. They are no longer written, and the
    # client still dual-reads the old session name, so this only drops the
    # csrf and role leftovers that nothing reads any more.
    resp.delete_cookie(key=_LEGACY_CSRF_COOKIE, path="/", domain=".aldifhr.my.id")
    resp.delete_cookie(key=_LEGACY_ROLE_COOKIE, path="/", domain=".aldifhr.my.id")

def _password_ok(pw: str) -> bool:
    return bool(pw and settings.DASHBOARD_PASSWORD and hmac.compare_digest(pw, str(settings.DASHBOARD_PASSWORD)))

@router.post("/auth")
async def auth_handler(request: Request):
    action = request.query_params.get("action", "login")

    if action == "refresh":
        token = _get_session_cookie(request)
        if not token or not role_from_jwt(token):
            return JSONResponse({"success": False, "error": "unauthorized"}, status_code=401)
        new_token = _issue_jwt()
        resp = JSONResponse({"success": True, "data": {"ok": True}})
        _set_session_cookies(resp, new_token)
        return resp

    if action not in ("login",):
        return JSONResponse({"success": False, "error": "Unknown action"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"success": False, "error": "Invalid body"}, status_code=400)
    try:
        data = LoginRequest.model_validate(body)
    except Exception as ve:
        from pydantic import ValidationError as _VE
        if isinstance(ve, _VE):
            return JSONResponse(content={"success": False, "error": "validation_error", "details": ve.errors()}, status_code=422)
        raise
    password = str(data.password).strip()

    if not password or not _password_ok(password):
        return JSONResponse({"success": False, "error": "Invalid credentials"}, status_code=401)

    token = _issue_jwt()
    resp = JSONResponse({"success": True, "data": {"ok": True}})
    _set_session_cookies(resp, token)
    return resp

@router.get("/auth")
async def auth_me(request: Request):
    token = _get_session_cookie(request)
    if not token or not role_from_jwt(token):
        return JSONResponse({"success": False, "error": "unauthorized"}, status_code=401)
    return JSONResponse({"success": True, "data": {"authenticated": True}})
