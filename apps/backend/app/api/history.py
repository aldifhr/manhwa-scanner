"""History — recent chapters grouped."""
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.logger import get_logger
from app.utils.request_auth import safe_error, require_monitor_auth
from app.utils.cover_scrub import batch_cover_ref

logger = get_logger("api:history")
router = APIRouter()


@router.get("/history")
async def history(request: Request):
    if not require_monitor_auth(request):
        return JSONResponse(content={"success": False, "error": "unauthorized"}, status_code=401)
    from app.db import get_supabase

    all_param = request.query_params.get("all") == "true"
    limit = 200 if all_param else 50
    try:
        res = (
            get_supabase()
            .table("recent_chapters")
            .select("*")
            .order("updated_time", desc=True)
            .limit(limit)
            .execute()
        )
        tks: list[str] = []
        groups: dict[str, dict] = {}
        for row in res.data or []:
            tk = row.get("title_key", "")
            if tk and tk not in groups:
                tks.append(tk)
                groups[tk] = {
                    "title": row.get("title"),
                    "titleKey": tk,
                    "cover": "",
                    "chapters": [],
                }
            if tk in groups:
                ch_str = str(row.get("chapter") or "0")
                ch_num = int(re.sub(r"\D", "", ch_str) or 0)
                groups[tk]["chapters"].append({
                    "chapterLabel": f"Ch. {row.get('chapter')}",
                    "chapterNumber": ch_num,
                    "url": row.get("chapter_url"),
                    "source": row.get("source"),
                    "sentAt": row.get("updated_time"),
                })
        covers = batch_cover_ref(tks)
        for tk in groups:
            groups[tk]["cover"] = covers.get(tk, "")
        return JSONResponse(content={"success": True, "data": {"results": list(groups.values())}})
    except Exception as e:
        return JSONResponse(content=safe_error(e), status_code=500)
