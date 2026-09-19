import os
os.environ['ENVIRONMENT']='development'
os.environ['DATABASE_URL']='postgresql://postgres:postgres@localhost:5432/manhwa'
os.environ['REDIS_URL']=''
os.environ['DISCORD_ENABLED']='false'
from datetime import datetime, timezone, timedelta
from app.scrapers.shinigami import get_shinigami_latest_updates, _api, _CLIENT
import psycopg2

cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
print(f"cutoff 24h: {cutoff.isoformat()}")
print("="*70)

def raw_fetch(path):
    r = _CLIENT.get(f"{_api()}{path}")
    return r.json() if r.status_code==200 else None

# 1. Scraper early-stop
for per_page in (24, 100):
    res = get_shinigami_latest_updates(page=1, per_page=per_page, max_pages=10, hours_cutoff=24)
    print(f"scraper per_page {per_page} => {len(res)} series (early-stop)")

# 2. Live counts
for mtype in ("project","mirror"):
    d = raw_fetch(f"/manga/list?type={mtype}&page=1&page_size=24&is_update=true&sort=latest&sort_order=desc")
    print(f"live {mtype} p1/24 is_update total {d.get('meta',{}).get('total_record')} got {len(d.get('data',[]))}")

for mtype in ("project","mirror"):
    d = raw_fetch(f"/manga/list?type={mtype}&page=1&page_size=100&is_update=true&sort=latest&sort_order=desc")
    print(f"live {mtype} p1/100 is_update got {len(d.get('data',[]))} total {d.get('meta',{}).get('total_record')}")

# 3. Collector filtered
from unittest.mock import patch
from app.cron.collectors.shinigami import _collect_shinigami_source
scraped = get_shinigami_latest_updates(page=1, per_page=100, max_pages=10, hours_cutoff=24)
with patch('app.scrapers.shinigami.get_shinigami_latest_updates', return_value=scraped):
    items = _collect_shinigami_source({}, set(), fetch_meta=False)
print(f"collector filtered 24h items: {len(items)} from {len(scraped)} series")
# check painter
print(f"Painter items: {sum(1 for i in items if 'Painter' in i['title'])} (should be 1)")

# 4. DB
conn=psycopg2.connect('postgresql://postgres:postgres@localhost:5432/manhwa')
cur=conn.cursor()
cur.execute("select count(*) from recent_chapters where source='shinigami' and updated_time >= %s", (cutoff.isoformat(),))
print(f"DB shinigami within 24h: {cur.fetchone()[0]}")
cur.execute("select count(*) from recent_chapters where source='shinigami'")
print(f"DB shinigami total: {cur.fetchone()[0]}")
# live vs DB: check any live fresh not in DB?
print("Done")
conn.close()
