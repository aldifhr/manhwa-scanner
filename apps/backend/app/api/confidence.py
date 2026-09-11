"""Scanner confidence API — per-item and per-source confidence scoring."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.logger import get_logger
from app.services.scanner_confidence import compute_confidence, attach_confidence
from app.utils.request_auth import safe_error, require_monitor_auth

logger = get_logger("api:confidence")
router = APIRouter()


@router.get("/confidence")
async def confidence_list(request: Request):
    """Return confidence scores for recent collector items per source.

    Query params:
        source: ikiru|shinigami|voratoon (default: all)
        limit: max items per source (default 20, max 100)
    """
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    source = request.query_params.get("source", "").strip().lower()
    try:
        limit = min(int(request.query_params.get("limit", "20")), 100)
    except (TypeError, ValueError):
        limit = 20

    sources = [source] if source in settings.SOURCE_KEYS else list(settings.SOURCE_KEYS)

    try:
        from app.db import get_supabase
        sb = get_supabase()
        results = {}
        for src in sources:
            try:
                rows = (
                    sb.table("recent_chapters")
                    .select("*")
                    .eq("source", src)
                    .order("updated_time", desc=True)
                    .limit(limit)
                    .execute()
                    .data
                    or []
                )
                # Attach confidence to each row
                for r in rows:
                    r["confidence"] = compute_confidence(src, r)
                results[src] = {
                    "items": rows,
                    "avg_confidence": round(
                        sum(float(r.get("confidence", 0)) for r in rows) / len(rows), 1
                    )
                    if rows
                    else 0,
                    "count": len(rows),
                }
            except Exception as e:
                logger.warn("confidence query failed", source=src, err=str(e)[:120])
                results[src] = {"items": [], "avg_confidence": 0, "count": 0, "error": str(e)[:120]}

        return JSONResponse(content={"success": True, "data": results})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)


@router.post("/confidence/evaluate")
async def confidence_evaluate(request: Request):
    """Evaluate confidence for a single item (ad-hoc check).

    Body: { "source": "ikiru", "chapter_data": {...} }
    """
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"success": False, "error": "invalid JSON"}, status_code=400)

    source = (body.get("source") or "").strip().lower()
    chapter_data = body.get("chapter_data", {})

    if source not in settings.SOURCE_KEYS:
        return JSONResponse(
            content={"success": False, "error": f"invalid source: {source}"},
            status_code=400,
        )
    if not chapter_data:
        return JSONResponse(
            content={"success": False, "error": "chapter_data required"},
            status_code=400,
        )

    score = compute_confidence(source, chapter_data)
    return JSONResponse(content={"success": True, "data": {"source": source, "confidence": score}})
