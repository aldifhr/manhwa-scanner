import psycopg2
from datetime import datetime, timezone, timedelta
conn=psycopg2.connect('postgresql://postgres:postgres@localhost:5432/manhwa')
cur=conn.cursor()
cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
print(f"cutoff {cutoff}")

cur.execute("select count(*) from recent_chapters where release_date >= %s", (cutoff,))
print("release_date >= cutoff", cur.fetchone()[0])
cur.execute("select count(*) from recent_chapters where updated_time >= %s", (cutoff,))
print("updated_time >= cutoff", cur.fetchone()[0])
cur.execute("select count(*) from recent_chapters where release_date is null")
print("release_date null", cur.fetchone()[0])
cur.execute("select count(*) from recent_chapters where updated_time is null")
print("updated_time null", cur.fetchone()[0])

# check Lazy Sovereign release_date
cur.execute("select title, chapter, release_date, updated_time from recent_chapters where title ilike '%Lazy Sovereign%'")
for r in cur.fetchall():
    print(f"Lazy Sovereign: {r}")

# check top by release_date
cur.execute("select title, chapter, release_date from recent_chapters where release_date >= %s order by release_date desc limit 5", (cutoff,))
print("\ntop 5 by release_date desc:")
for r in cur.fetchall():
    print(r)

# check via rss service directly
import os
os.environ['ENVIRONMENT']='development'
from app.services.rss_service import _fetch_rss_data_sync
results, _, _, _ = _fetch_rss_data_sync(cutoff=cutoff, limit=100, page=1, fetch_limit=1000)
print(f"\nrss_service results: {len(results)}")
# check if Lazy Sovereign in results
found = [r for r in results if 'Lazy Sovereign' in r.get('title','')]
print(f"Lazy Sovereign in rss_service: {len(found)}")
for f in found:
    print(f"  {f['title']} {f['chapter']} {f.get('release_date')} {f.get('updated_time')}")

conn.close()
