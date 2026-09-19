import os
os.environ['ENVIRONMENT']='development'
os.environ['DATABASE_URL']='postgresql://postgres:postgres@localhost:5432/manhwa'
os.environ['REDIS_URL']=''
os.environ['DISCORD_ENABLED']='false'
from datetime import datetime, timezone, timedelta
from app.scrapers.shinigami import get_shinigami_latest_updates, _api, _CLIENT
import psycopg2

mid = "e53a5528-943c-462f-b3ff-004d4aa8c08f"
cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
print(f"cutoff: {cutoff.isoformat()}")
print(f"mid: {mid}")

# 1. Check detail
def raw(path):
    r = _CLIENT.get(f"{_api()}{path}")
    return r.json() if r.status_code==200 else None

detail = raw(f"/manga/detail/{mid}")
print("\n== detail ==")
if detail:
    d = detail.get('data',{})
    print(f"title: {d.get('title')}")
    print(f"latest_chapter_time: {d.get('latest_chapter_time')}")
    print(f"updated_at: {d.get('updated_at')}")
    try:
        dt = datetime.fromisoformat(d.get('latest_chapter_time').replace('Z','+00:00'))
        print(f"within 24h? {dt >= cutoff} age {(datetime.now(timezone.utc)-dt).total_seconds()/3600:.1f}h")
    except Exception as e:
        print(e)
    print(f"taxonomy Type: {d.get('taxonomy',{}).get('Type')}")
else:
    print("detail fetch fail")

# 2. Check if in get_shinigami_latest_updates
print("\n== get_shinigami_latest_updates ==")
scraped = get_shinigami_latest_updates(page=1, per_page=100, max_pages=10, hours_cutoff=24)
found = [x for x in scraped if x.get('manga_id')==mid]
print(f"found in scraped? {bool(found)} len scraped {len(scraped)}")
if found:
    print(f"found item: latest_chapter_time {found[0].get('latest_chapter_time')} chapters {len(found[0].get('chapters') or [])}")
    for ch in (found[0].get('chapters') or [])[:3]:
        print(f"  ch {ch.get('chapter_number')} @ {ch.get('created_at')}")
else:
    # check where it appears in live pagination
    print("not found, checking live pagination")
    for mtype in ("project","mirror"):
        for p in [1,2]:
            data = raw(f"/manga/list?type={mtype}&page={p}&page_size=100&is_update=true&sort=latest&sort_order=desc")
            if data:
                ids = [x.get('manga_id') for x in data.get('data',[])]
                if mid in ids:
                    idx = ids.index(mid)
                    print(f"found in live {mtype} p{p} idx {idx} total {len(ids)}")
                    # check has_fresh for that page
                    from datetime import datetime as dt2
                    has_fresh = any(
                        (lambda ts: (lambda: (dt2.fromisoformat(ts.replace('Z','+00:00')) >= cutoff) if ts else False)())(x.get('latest_chapter_time') or x.get('updated_at') or "")
                        for x in data.get('data',[])
                    )
                    print(f"  page has_fresh? {has_fresh}")
                else:
                    print(f"not in {mtype} p{p}")

# 3. Check collector
print("\n== collector ==")
from unittest.mock import patch
from app.cron.collectors.shinigami import _collect_shinigami_source
with patch('app.scrapers.shinigami.get_shinigami_latest_updates', return_value=scraped):
    items = _collect_shinigami_source({}, set(), fetch_meta=False)
found_c = [i for i in items if 'Lazy Sovereign' in i['title']]
print(f"collector items for Lazy Sovereign: {len(found_c)}")
for i in found_c:
    print(f"  ch {i['chapter']} @ {i['updated_time']}")

# 4. Check DB
print("\n== DB recent_chapters ==")
conn=psycopg2.connect('postgresql://postgres:postgres@localhost:5432/manhwa')
cur=conn.cursor()
cur.execute("select title, chapter, updated_time from recent_chapters where source='shinigami' and title ilike '%Lazy Sovereign%' order by updated_time desc")
rows=cur.fetchall()
print(f"DB rows for Lazy Sovereign: {len(rows)}")
for r in rows:
    print(r)
# also check by title_key
cur.execute("select title_key, title, source from whitelist where title ilike '%Lazy Sovereign%'")
print("whitelist:", cur.fetchall())
conn.close()
