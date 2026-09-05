"""Auth endpoint: POST /api/auth?action=login|refresh|register.

Sets the `ikiru_dashboard_session` JWT cookie used by the FE gate.

Actions:
  - login    : password or email+password -> issue JWT (admin/member)
  - register : email+password -> create app_users (member) + issue JWT
  - refresh  : valid JWT cookie -> re-issue (exp +7d)
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets as _secrets
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import jwt as _jwt

from app.config import settings

router = APIRouter()

_COOKIE_SESSION = "ikiru_dashboard_session"
_COOKIE_CSRF = "ikiru_csrf_token"
_COOKIE_ROLE = "ikiru_role"
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


def _hash_password(pw: str) -> str:
    salt = os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 100_000).hex()
    return f"{salt}${dk}"

def _verify_password(pw: str, h: str) -> bool:
    try:
        salt, dk = h.split("$", 1)
        nd = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 100_000).hex()
        return hmac.compare_digest(dk, nd)
    except Exception:
        return False

def _set_session_cookies(resp: JSONResponse, token: str) -> None:
    role = role_from_jwt(token) or "member"
    resp.set_cookie(
        key=_COOKIE_SESSION,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
        max_age=_COOKIE_MAX_AGE,
    )
    resp.set_cookie(
        key=_COOKIE_ROLE,
        value=role,
        httponly=False,  # readable by JS for nav gating (httpOnly session can't be read)
        secure=True,
        samesite="lax",
        path="/",
        max_age=_COOKIE_MAX_AGE,
    )
    csrf_token = _secrets.token_urlsafe(32)
    resp.set_cookie(
        key=_COOKIE_CSRF,
        value=csrf_token,
        httponly=False,
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

    # ---- Register: email+password -> app_users (member) ----
    if action == "register":
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"success": False, "error": "Invalid body"}, status_code=400)
        email = str(body.get("email", "")).strip().lower() if isinstance(body, dict) else ""
        password = str(body.get("password", "")).strip() if isinstance(body, dict) else ""
        if not email or not re.match(r"^[^@]+@[^@]+\.[^@]+$", email):
            return JSONResponse({"success": False, "error": "Email invalid"}, status_code=400)
        if len(password) < 6:
            return JSONResponse({"success": False, "error": "Password min 6 char"}, status_code=400)
        from app.db import get_supabase
        sb = get_supabase()
        try:
            existing = sb.table("app_users").select("id").eq("email", email).execute()
            if existing.data:
                return JSONResponse({"success": False, "error": "Email already registered"}, status_code=409)
        except Exception:
            pass
        ph = _hash_password(password)
        try:
            sb.table("app_users").insert({"email": email, "password_hash": ph, "role": "member"}).execute()
        except Exception as e:
            return JSONResponse({"success": False, "error": str(e)[:120]}, status_code=500)
        token = _issue_jwt("member")
        resp = JSONResponse({"success": True, "data": {"ok": True, "role": "member"}})
        _set_session_cookies(resp, token)
        return resp

    # ---- Login: password -> JWT ----
    if action != "login":
        return JSONResponse({"success": False, "error": "Unknown action"}, status_code=400)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Invalid body"}, status_code=400)

    password = str(body.get("password", "")).strip() if isinstance(body, dict) else ""
    email = str(body.get("email", "")).strip().lower() if isinstance(body, dict) else ""
    # email+password login for registered members (DB)
    if email and password:
        from app.db import get_supabase
        sb = get_supabase()
        try:
            r = sb.table("app_users").select("password_hash,role").eq("email", email).maybe_single().execute()
            row = getattr(r, "data", None)
            if row and _verify_password(password, row.get("password_hash") or ""):
                role = row.get("role") or "member"
                token = _issue_jwt(role)
                resp = JSONResponse({"success": True, "data": {"ok": True, "role": role}})
                _set_session_cookies(resp, token)
                return resp
        except Exception:
            pass
        return JSONResponse({"success": False, "error": "Invalid credentials"}, status_code=401)

    if not password:
        return JSONResponse({"success": False, "error": "Invalid credentials"}, status_code=401)

    # Two roles: admin (MONITOR_AUTH_TOKEN) and member (MEMBER_AUTH_TOKEN or DB).
    # ponytail: drop MEMBER_AUTH_TOKEN static when DB has users (>0) — keep admin token always
    role = None
    if settings.MONITOR_AUTH_TOKEN and hmac.compare_digest(password, settings.MONITOR_AUTH_TOKEN):
        role = "admin"
    elif settings.MEMBER_AUTH_TOKEN and hmac.compare_digest(password, settings.MEMBER_AUTH_TOKEN):
        # yagni dual source — check DB has users, if yes ignore static member token
        try:
            from app.db import get_supabase as _sb2
            _cnt = _sb2().table("app_users").select("id", count="exact").limit(1).execute()
            has_users = (_cnt.count or 0) > 0 if hasattr(_cnt, "count") else bool(_cnt.data)
            if not has_users:
                role = "member"
        except Exception:
            role = "member"
    if not role:
        return JSONResponse({"success": False, "error": "Invalid credentials"}, status_code=401)

    token = _issue_jwt(role)
    resp = JSONResponse({"success": True, "data": {"ok": True, "role": role}})
    _set_session_cookies(resp, token)
    return resp


@router.get("/auth")
async def auth_me(request: Request):
    token = _get_session_cookie(request)
    role = role_from_jwt(token) if token else None
    if not role:
        return JSONResponse({"success": False, "error": "unauthorized"}, status_code=401)
    return JSONResponse({"success": True, "data": {"role": role}})


# Discord OAuth login has been removed.
