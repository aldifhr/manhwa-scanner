"""OpenAPI customizer — whitelist pagination params."""
from fastapi.openapi.utils import get_openapi

_openapi_schema = None


def custom_openapi(app):
    global _openapi_schema
    if _openapi_schema:
        return _openapi_schema
    schema = get_openapi(title="manhwa-backend", version="1.0.0", description="Ikiru Bot manhwa scraper API. Backend runs fully on local VPS Postgres (no Supabase). Use Bearer token for protected endpoints.", routes=app.routes)
    schema["servers"] = [{"url": "https://scanner.aldifhr.fun", "description": "Production (VPS)"}]
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["BearerAuth"] = {"type": "http", "scheme": "bearer"}
    for path in schema.get("paths", {}).values():
        for method in path.values():
            method.setdefault("security", [{"BearerAuth": []}])
    _wl_params = [
        {"name": "page", "in": "query", "required": False, "schema": {"type": "integer", "default": 1, "minimum": 1}, "description": "Page number (1-based)."},
        {"name": "page_size", "in": "query", "required": False, "schema": {"type": "integer", "default": 100, "minimum": 1, "maximum": 10000}, "description": "Rows per page (1..10000)."},
        {"name": "source", "in": "query", "required": False, "schema": {"type": "string", "enum": ["ikiru", "shinigami", "voratoon"]}, "description": "Filter by source."},
        {"name": "title", "in": "query", "required": False, "schema": {"type": "string"}, "description": "Case-insensitive title search."},
        {"name": "cursor", "in": "query", "required": False, "schema": {"type": "string"}, "description": "Keyset cursor (created_at ISO) for pagination — preferred over page for large tables."},
    ]
    for _p in ("/api/v1/whitelist", "/api/v1/reader/whitelist"):
        _ep = schema.get("paths", {}).get(_p, {}).get("get")
        if _ep is not None:
            _ep["parameters"] = _wl_params
    _openapi_schema = schema
    return schema
