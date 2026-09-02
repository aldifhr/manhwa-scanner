import time, re, sys
sys.path.insert(0, '/root/projects/manhwa-backend')
from app.db import get_supabase
from datetime import datetime, timezone, timedelta
from app.scrapers import shinigami as sh, ikiru as ik

sb = get_supabase()
# Backfill ALL recent_chapters (RSS API returns all-time, not just 24h)
rc = sb.table("recent_chapters").select("title_key, source, series_url, rating, genres").execute()
rows = rc.data or []
need = [r for r in rows if (r.get("rating") in (None, "")) or not r.get("genres")]
print(f"rows 72h: {len(rows)} | need enrich: {len(need)}", flush=True)
done = 0
for r in need:
    tk, src = r["title_key"], r["source"]
    su = r.get("series_url") or ""
    slug = su.rstrip("/").split("/")[-1] if su else ""
    if not slug:
        continue
    meta = None
    try:
        if src == "shinigami":
            m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", su)
            if m:
                meta = sh.get_shinigami_series_meta(m.group(1))
        elif src == "ikiru":
            meta = ik.get_ikiru_series_meta(slug)
        elif src == "voratoon":
            try:
                import httpx
                from app.scrapers.voratoon import BASE_URL, TIMEOUT
                vurl = f"{BASE_URL}/series"
                vparams = {"take": 1, "page": 1, "includeMeta": "true", "filter": f"slug={slug}"}
                vr = httpx.get(vurl, params=vparams, timeout=TIMEOUT)
                if vr.status_code == 200:
                    vpayload = vr.json()
                    vseries = (vpayload.get("data") or [])
                    if vseries:
                        vd = vseries[0].get("data", {})
                        vgenres = [g.get("data", {}).get("name", "") for g in (vd.get("genres") or []) if g.get("data", {}).get("name")]
                        meta = {
                            "rating": vd.get("rating"),
                            "genres": vgenres,
                        }
            except Exception:
                pass
    except Exception as e:
        print(f"  ERR {src} {tk}: {e}", flush=True)
    if meta:
        upd = {}
        rt = meta.get("rating")
        if rt not in (None, "", 0):
            upd["rating"] = str(rt)
        gn = meta.get("genres") or []
        if gn:
            upd["genres"] = gn
        if upd:
            sb.table("recent_chapters").update(upd).eq("title_key", tk).eq("source", src).execute()
            done += 1
    time.sleep(1.0)
print(f"BACKFILL DONE: enriched {done}/{len(need)}", flush=True)
