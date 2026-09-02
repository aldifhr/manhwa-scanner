"""Backfill: fix broken ikiru chapter URLs in recent_chapters.

Broken shape (scraper bug):
  https://07.ikiru.wtf/manga/<series>-chapter-154/chapter-154.887128/
Correct shape:
  https://07.ikiru.wtf/manga/<series>/chapter-154.887128/

The series slug is the manga-path segment with the trailing "-chapter-N"
removed. The chapter number + cid stay the same. We reconstruct from the
broken URL itself (no upstream re-fetch needed).
"""
from __future__ import annotations
import re
from app.db import get_supabase
from app.logger import get_logger

logger = get_logger("backfill:ikiru-urls")

_CHAPTER_RE = re.compile(r"/chapter-(\d+(?:\.\d+)?)\.(\w+)/?$")


def _fix_url(u: str, base: str) -> str | None:
    if "/manga/" not in u:
        return None
    seg = u.split("/manga/", 1)[1]
    # manga path up to /chapter-
    if "/chapter-" not in seg:
        return None
    manga_part, chap_part = seg.split("/chapter-", 1)
    # strip trailing "-chapter-N" from the manga slug if present
    m = re.match(r"^(.*)-chapter-\d+(?:\.\d+)?$", manga_part)
    series_slug = m.group(1) if m else manga_part
    cm = _CHAPTER_RE.search(u)
    if not cm:
        return None
    num, cid = cm.group(1), cm.group(2)
    return f"{base}/manga/{series_slug}/chapter-{num}.{cid}/"


def main():
    sb = get_supabase()
    base = "https://07.ikiru.wtf"
    rows = sb.table("recent_chapters").select("id, chapter_url, source").eq("source", "ikiru").execute().data or []
    fixed = 0
    for r in rows:
        u = r.get("chapter_url") or ""
        if "/manga/" not in u:
            continue
        manga_seg = u.split("/manga/")[1].split("/chapter-")[0]
        if "-chapter-" not in manga_seg:
            continue  # already correct
        new = _fix_url(u, base)
        if not new or new == u:
            continue
        try:
            sb.table("recent_chapters").update({"chapter_url": new}).eq("id", r["id"]).execute()
            fixed += 1
        except Exception as e:
            logger.warn("update failed", id=r["id"], err=str(e)[:120])
    logger.info("ikiru url backfill done", scanned=len(rows), fixed=fixed)


if __name__ == "__main__":
    main()
