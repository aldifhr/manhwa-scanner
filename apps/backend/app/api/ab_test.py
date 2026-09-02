"""A/B Testing API — manage and track A/B tests."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import require_monitor_auth
from app.services.ab_test import (
    ACTIVE_TESTS,
    get_variant,
    get_notification_format,
    track_test_event,
    get_test_results,
    TestVariant,
)

logger = get_logger("api:ab_test")
router = APIRouter()


@router.get("/api/v1/ab-tests")
async def ab_tests_list(request: Request):
    """List active A/B tests."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    return JSONResponse(content={
        "success": True,
        "data": {
            name: {
                "description": test["description"],
                "variants": [str(v) for v in test["variants"]],
                "weights": test["weights"],
            }
            for name, test in ACTIVE_TESTS.items()
        }
    })


@router.get("/api/v1/ab-tests/{test_name}/variant")
async def ab_test_variant(request: Request, test_name: str, user_id: str = "default"):
    """Get the variant for a user."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    variant = get_variant(test_name, user_id)
    format_config = get_notification_format(variant)
    
    return JSONResponse(content={
        "success": True,
        "data": {
            "test": test_name,
            "variant": str(variant),
            "format": format_config,
        }
    })


@router.post("/api/v1/ab-tests/{test_name}/track")
async def ab_test_track(request: Request, test_name: str):
    """Track an A/B test event."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    try:
        body = await request.json()
        variant = TestVariant(body.get("variant", "control"))
        event = body.get("event", "unknown")
        metadata = body.get("metadata", {})
        
        track_test_event(test_name, variant, event, metadata)
        return JSONResponse(content={"success": True})
    except Exception as e:
        logger.warn("ab_test track failed", err=str(e)[:120])
        return JSONResponse(content={"success": False, "error": "internal error"}, status_code=500)


@router.get("/api/v1/ab-tests/{test_name}/results")
async def ab_test_results(request: Request, test_name: str):
    """Get A/B test results."""
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    
    results = get_test_results(test_name)
    return JSONResponse(content={"success": True, "data": results})
