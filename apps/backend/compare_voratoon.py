import os
os.environ['ENVIRONMENT']='development'
os.environ['DATABASE_URL']='postgresql://postgres:postgres@localhost:5432/manhwa'
os.environ['REDIS_URL']=''
os.environ['DISCORD_ENABLED']='false'
from datetime import datetime, timezone, timedelta
import httpx, psycopg2, json

cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
print(f"cutoff 24h: {cutoff.isoformat()}")
print("="*70)

# 1. DB
conn=psycopg2.connect('postgresql://postgres:postgres@localhost:5432/manhwa')
cur=conn.cursor()
cur.execute("select count(*) from recent_chapters where source='voratoon'")
print(f"DB voratoon total: {cur.fetchone()[0]}")
cur.execute("select count(*) from recent_chapters where source='voratoon' and updated_time >= %s", (cutoff.isoformat(),))
print(f"DB voratoon within 24h: {cur.fetchone()[0]}")
cur.execute("select title, chapter, updated_time from recent_chapters where source='voratoon' order by updated_time desc limit 5")
for r in cur.fetchall():
    print(f"  DB: {r[0][:40]} ch {r[1]} @ {r[2]}")

# 2. Scraper
from app.scrapers.voratoon import collect_voratoon
scraped = collect_voratoon()
print(f"\nscraper collect_voratoon(): {len(scraped)} chapter-items")
# check within 24h
cnt_fresh = sum(1 for s in scraped if s.get('updated_time') and datetime.fromisoformat(s['updated_time'].replace('Z','+00:00')) >= cutoff)
print(f"  within 24h (by updated_time): {cnt_fresh} / {len(scraped)}")
# distinct titles
from collections import Counter
c = Counter(s['title'] for s in scraped)
print(f"  distinct titles: {len(c)}")

# 3. Live API direct
from app.config import settings
base = settings.VORATOON_API_URL.rstrip('/')
import time
def fetch_live(fmt, take=30, page=1):
    url = f"{base}/series"
    params = {"take": take, "page": page, "sort": "latest", "sortOrder": "desc", "includeMeta": "true", "takeChapter": 50, "format": fmt}
    try:
        r = httpx.get(url, params=params, timeout=15, headers={"Accept-Encoding":"gzip, deflate"})
        j = r.json()
        data = j.get('data',[])
        # count fresh chapters in this page
        fresh = 0
        for s in data:
            for ch in (s.get('chapters') or []):
                stamp = ch.get('createdAt') or ch.get('updatedAt') or ""
                try:
                    dt = datetime.fromisoformat(stamp.replace('Z','+00:00'))
                    if dt >= cutoff:
                        fresh+=1
                except: pass
        return len(data), fresh, j.get('meta',{})
    except Exception as e:
        print(f"fetch {fmt} fail {e}")
        return 0,0, {}

print("\nLive API direct (take 30, page 1):")
for fmt in ("manhwa","manhua","mangatoon"):
    n, fresh, meta = fetch_live(fmt, 30, 1)
    print(f"  {fmt}: {n} series, {fresh} fresh chapters in page, meta {meta.get('lastPage') if meta else '?'}")

print("\nLive API page 2 (check early-stop):")
for fmt in ("manhwa",):
    n, fresh, meta = fetch_live(fmt, 30, 2)
    print(f"  manhwa p2: {n} series, {fresh} fresh chapters")

# 4. Compare: is DB missing fresh?
print("\nCheck if scraper misses fresh live:")
# fetch live page1 for manhwa and see titles
# get live titles
try:
    r = httpx.get(f"{base}/series", params={"take":5,"page":1,"sort":"latest","sortOrder":"desc","includeMeta":"true","takeChapter":5,"format":"manhwa"}, timeout=15)
    j=r.json()
    live_titles = [s.get('data',{}).get('title','') for s in j.get('data',[])[:3]]
    print(f"  live sample titles: {live_titles[:2]}")
    # check if in DB
    for t in live_titles[:2]:
        cur.execute("select count(*) from recent_chapters where title=%s and source='voratoon'", (t,))
        print(f"    '{t[:30]}' in DB: {cur.fetchone()[0]} rows")
except Exception as e:
    print("live sample fail", e)

conn.close()
print("Done")
