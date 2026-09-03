"""Backfill voratoon whitelist rows + scrub covers (A4/A5/A6).

For voratoon whitelist rows missing type/rating/genres/series_url, fetch the
series detail and fill them. Also scrub any remaining X-Amz presigned covers
to bare host/path so the FE routes through the proxy. Dedupe genres, drop
rating "0" strings to null.

Idempotent + safe.
"""
from __future__ import annotations
import re
from app.db import get_supabase
from app.utils.cover_scrub import scrub_cover


def _dedupe_genres(g):
    if not isinstance(g, list):
        return []
    out, seen = [], set()
    for x in g:
        if not isinstance(x, str):
            continue
        k = x.strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(x.strip())
    return out


def main():
    sb = get_supabase()
    rows = sb.table("whitelist").select("*").eq("source", "voratoon").execute().data or []
    print(f"voratoon rows: {len(rows)}")

    updated = 0
    for r in rows:
        rid = r["id"]
        patch = {}
        # A4: fill missing fields from source detail
        slug = None
        _m = re.search(r"/series/([^/?#]+)", r.get("series_url") or "")
        if _m:
            slug = _m.group(1)
        elif r.get("title_key"):
            slug = r["title_key"].replace(" ", "-")
        if slug and (not r.get("type") or not r.get("genres") or not r.get("series_url")):
            try:
                from app.scrapers import voratoon as vt
                d = vt.fetch_series_detail(slug)
                if d:
                    data = d.get("data", {})
                    if not r.get("type") and data.get("format"):
                        patch["type"] = data["format"].lower()
                    if not r.get("genres"):
                        gs = [g.get("data", {}).get("name", "") for g in data.get("genres", []) if g.get("data", {}).get("name")]
                        if gs:
                            patch["genres"] = gs
                    if not r.get("series_url"):
                        patch["series_url"] = f"https://v1.voratoon.com/series/{slug}"
                    if not r.get("rating") and data.get("rating"):
                        patch["rating"] = str(data["rating"])
                    if not r.get("cover") and data.get("coverImage"):
                        patch["cover"] = scrub_cover(data["coverImage"])
                    if not r.get("description") and data.get("synopsis"):
                        patch["description"] = data["synopsis"]
            except Exception as e:
                print(f"  fetch failed {rid}: {e}")

        # A5: scrub any X-Amz cover still stored
        cov = r.get("cover") or ""
        if "X-Amz-Expires" in cov or "X-Amz-Date" in cov:
            new_cov = scrub_cover(cov)
            if new_cov != cov:
                patch["cover"] = new_cov

        # A6: normalize genres (dedupe) + rating "0" -> null
        if isinstance(r.get("genres"), list):
            dg = _dedupe_genres(r["genres"])
            if dg != r["genres"]:
                patch["genres"] = dg
        if r.get("rating") == "0" or r.get("rating") == 0:
            patch["rating"] = None

        if patch:
            sb.table("whitelist").update(patch).eq("id", rid).execute()
            updated += 1

    print(f"updated: {updated}")

    # Final verify
    vo = sb.table("whitelist").select("id,type,rating,genres,series_url,cover").eq("source", "voratoon").execute().data or []
    print("--- verify ---")
    print("  type null:", sum(1 for r in vo if not r.get("type")))
    print("  genres empty:", sum(1 for r in vo if not r.get("genres")))
    print("  series_url null:", sum(1 for r in vo if not r.get("series_url")))
    print("  cover X-Amz:", sum(1 for r in vo if "X-Amz-Expires" in (r.get("cover") or "")))
    print("  rating==0:", sum(1 for r in vo if r.get("rating") in ("0", 0)))


if __name__ == "__main__":
    main()
