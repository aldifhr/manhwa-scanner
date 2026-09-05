"""Auto-split from dashboard.py — whitelist routes."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal, Optional

from app.logger import get_logger
from app.services.whitelist_service import (
    get_dispatch_history,
    get_whitelist,
    post_whitelist,
    delete_whitelist,
    patch_whitelist,
    normalize_whitelist_urls,
)
from app.utils.request_auth import require_monitor_auth, require_role_auth, int_safe, safe_error

logger = get_logger("api:whitelist")
router = APIRouter()


class WhitelistCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    title: str = Field(..., min_length=1, max_length=200)
    source: Literal["ikiru", "shinigami", "voratoon"] = Field(default="ikiru")
    title_key: Optional[str] = Field(default=None, max_length=200)
    titleKey: Optional[str] = Field(default=None, max_length=200)
    cover: Optional[str] = Field(default=None, max_length=2000)
    rating: Optional[float | str] = None
    origin: Optional[Literal["KR", "CN"]] = None
    type: Optional[Literal["manhwa", "manhua", "manga"]] = None
    genres: Optional[list[str]] = None
    description: Optional[str] = Field(default=None, max_length=5000)
    status: Optional[str] = Field(default=None, max_length=50)
    url: Optional[str] = Field(default=None, max_length=500)
    seriesUrl: Optional[str] = Field(default=None, max_length=500)
    series_url: Optional[str] = Field(default=None, max_length=500)


class WhitelistPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    title_key: Optional[str] = Field(default=None, max_length=200)
    titleKey: Optional[str] = Field(default=None, max_length=200)
    title: Optional[str] = Field(default=None, max_length=200)
    source: Optional[Literal["ikiru", "shinigami", "voratoon", ""]] = None
    url: Optional[str] = Field(default=None, max_length=500)
    seriesUrl: Optional[str] = Field(default=None, max_length=500)
    series_url: Optional[str] = Field(default=None, max_length=500)
    status: Optional[str] = Field(default=None, max_length=50)
    rating: Optional[float | str] = None
    cover: Optional[str] = Field(default=None, max_length=2000)
    origin: Optional[Literal["KR", "CN"]] = None
    type: Optional[Literal["manhwa", "manhua", "manga"]] = None
    genres: Optional[list[str]] = None
    description: Optional[str] = Field(default=None, max_length=5000)


@router.get("/dispatch-history")
async def dispatch_history(request: Request):
    """Flat list of all dispatched (notified) chapters from dispatch_history."""
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        page = int_safe(request.query_params.get("page", "1"), 1)
        _ps_raw = request.query_params.get("page_size", "50")
        try:
            page_size = int(_ps_raw)
        except (ValueError, TypeError):
            page_size = 50
        if page_size > 1000 or page_size < 1:
            return JSONResponse(content={"success": False, "error": "page_size must be between 1 and 1000"}, status_code=400)
        search = request.query_params.get("search", "").strip().lower()
        return JSONResponse(content=get_dispatch_history(page, page_size, search))
    except Exception as e:
        logger.warn("dispatch-history failed", err=str(e))
        return JSONResponse(content=safe_error(e), status_code=500)


@router.get("/reader/dispatch-history")
async def dispatch_history_reader(request: Request):
    """Alias for FE compatibility — /api/v1/reader/dispatch-history → /api/v1/dispatch-history."""
    return await dispatch_history(request)


@router.get("/reader/whitelist")
async def get_whitelist_reader(request: Request):
    """Backward-compat alias — public GET for anon dashboard, same as /whitelist."""
    # ponytail: public GET, no auth
    page = request.query_params.get("page", "1")
    page_size = request.query_params.get("page_size", request.query_params.get("pageSize", "100"))
    _merge_raw = (request.query_params.get("merge") or "true").lower()
    _merge = _merge_raw not in ("false", "0", "no")
    cursor = request.query_params.get("cursor")
    return get_whitelist(page=page, page_size=page_size, merge=_merge, cursor=cursor)


@router.get("/whitelist")
async def whitelist_get(request: Request):
    # ponytail: public GET for anon/member dashboard
    try:
        source = request.query_params.get("source", "")
        title = request.query_params.get("title") or request.query_params.get("q", "")
        page = request.query_params.get("page", "1")
        page_size = request.query_params.get("page_size", request.query_params.get("pageSize", "100"))
        _merge_raw = (request.query_params.get("merge") or "true").lower()
        _merge = _merge_raw not in ("false", "0", "no")
        cursor = request.query_params.get("cursor")
        result = get_whitelist(source=source, title=title, page=page, page_size=page_size, merge=_merge, cursor=cursor)
        return JSONResponse(content=result)
    except Exception as e:
        logger.warn("whitelist failed", err=str(e))
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/reader/whitelist")
async def whitelist_post_reader(request: Request):
    """Alias for FE compatibility — /api/v1/reader/whitelist → /api/v1/whitelist."""
    return await whitelist_post(request)


@router.post("/whitelist")
async def whitelist_post(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse(content={"success": False, "error": "body must be an object"}, status_code=400)
    try:
        data = WhitelistCreate.model_validate(body)
    except Exception as ve:
        from pydantic import ValidationError as _VE
        if isinstance(ve, _VE):
            return JSONResponse(content={"success": False, "error": "validation_error", "details": ve.errors()}, status_code=422)
        raise
    # normalize aliases: title_key/titleKey -> title_key, seriesUrl/series_url/url -> url
    title = data.title
    url = data.url or data.seriesUrl or data.series_url
    source = data.source
    # build body dict for service (include all validated fields, keep original keys for service compat)
    body_dict = body  # service reads many aliases, keep original but validated
    # also ensure status/type are passed (previously silent drop)
    res = post_whitelist(title=title, url=url, source=source, body=body_dict)
    # Audit log disabled (audit.py removed 54a8ec5)
    # from app.services.audit import log_action, AuditAction
    # log_action(AuditAction.WHITELIST_ADD, actor=request.headers.get("x-forwarded-for", "system"), target=title, details={"source": source, "status": res.get("status")})
    return JSONResponse(content=res)


@router.delete("/whitelist")
async def whitelist_delete(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse(content={"success": False, "error": "body must be an object"}, status_code=400)

    # Accept any identifier the FE might send (id/title_key/title/url/source).
    title_key = body.get("title_key") or ""
    source = body.get("source") or ""
    entry_id = body.get("id") or ""
    title = body.get("title") or ""
    url = body.get("url") or ""
    if not any([title_key, entry_id, title, url]):
        # Fall back to deriving title_key from url/title (legacy behavior).
        if url:
            title_key = url.rstrip("/").split("/")[-1]
        elif title:
            title_key = title.lower().replace(" ", "-")
    if not any([title_key, entry_id, title, url]):
        return JSONResponse(content={"error": "one of title_key/id/title/url required"}, status_code=400)
    try:
        result = delete_whitelist(
            title_key=title_key,
            source=source,
            id=entry_id,
            title=title,
            url=url,
        )
        # Audit log disabled
        # from app.services.audit import log_action, AuditAction
        # log_action(AuditAction.WHITELIST_REMOVE, actor=request.headers.get("x-forwarded-for", "system"), target=title_key or title, details={"source": source, "status": result.get("status")})
        # Map not_found -> 404 so the FE gets a real signal instead of 200 ok.
        if result.get("status") == "not_found":
            return JSONResponse(content=result, status_code=404)
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.patch("/whitelist")
async def whitelist_patch(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse(content={"success": False, "error": "body must be an object"}, status_code=400)
    try:
        data = WhitelistPatch.model_validate(body)
    except Exception as ve:
        from pydantic import ValidationError as _VE2
        if isinstance(ve, _VE2):
            return JSONResponse(content={"success": False, "error": "validation_error", "details": ve.errors()}, status_code=422)
        raise
    # resolve title_key from aliases
    title_key = data.title_key or data.titleKey or ""
    if not title_key:
        url = data.url or data.seriesUrl or data.series_url or ""
        if url:
            title_key = url.rstrip("/").split("/")[-1]
        elif data.title:
            title_key = data.title.lower().replace(" ", "-")
    if not title_key:
        return JSONResponse(content={"success": False, "error": "title_key required"}, status_code=400)
    source = data.source or ""
    # updatable now includes type (previously silent drop)
    updatable = ("status", "rating", "cover", "origin", "genres", "description", "title", "series_url", "type")
    # map aliases to canonical keys
    alias_map = {"seriesUrl": "series_url", "titleKey": "title_key"}
    body_aliased = {}
    for k, v in body.items():
        body_aliased[alias_map.get(k, k)] = v
    updates = {}
    for f in updatable:
        v = body_aliased.get(f)
        if v is not None and v != "":
            updates[f] = v
    try:
        result = patch_whitelist(title_key, source, updates)
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/reader/whitelist/normalize-urls")
async def whitelist_normalize_urls(request: Request):
    if not require_role_auth(request, {"admin"}):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        body = {}
    dry_run = bool(body.get("dry_run") if isinstance(body, dict) else False)
    return JSONResponse(content=normalize_whitelist_urls(dry_run=dry_run))