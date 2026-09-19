"""Debug: compare API vs DB data for shinigami."""
import os
os.chdir('/root/projects/manhwa-scanner/apps/backend')

from app.db import get_supabase, q
from app.scrapers.shinigami import get_shinigami_latest_updates
from datetime import datetime, timezone, timedelta

# 1. Get data from API
scraped = get_shinigami_latest_updates() or []
print(f"API series count: {len(scraped)}")

# 2. Find series that should be in RSS but might be missing
# Check specific titles
titles_to_check = [
    "i-was-immediately-mistaken-for-a-monster-genius-actor",
    "top-tier-providence",
]

for title_search in titles_to_check:
    print(f"\n=== {title_search} ===")
    
    # API data
    api_series = [s for s in scraped if title_search.replace("-", " ") in (s.get("title", "") + s.get("manga_name", "")).lower()]
    if api_series:
        s = api_series[0]
        print(f"  API: {s.get('title', s.get('manga_name'))}")
        print(f"       chapters: {len(s.get('chapters', []))}")
        for ch in s.get("chapters", [])[:3]:
            print(f"         ch.{ch.get('chapter_number')} @ {ch.get('created_at')}")
    else:
        print("  API: NOT FOUND")
    
    # DB data
    db_rows = q("SELECT chapter_num, release_date, updated_time FROM recent_chapters WHERE title_key = %s AND source = 'shinigami' ORDER BY chapter_num DESC LIMIT 5", [title_search])
    if db_rows:
        for r in db_rows:
            print(f"  DB:  ch.{r['chapter_num']} release={str(r['release_date'])[:19] if r['release_date'] else 'NULL'} updated={str(r['updated_time'])[:19]}")
    else:
        print("  DB: NOT FOUND")

# 3. Check total counts
total_db = q("SELECT COUNT(*) as cnt FROM recent_chapters WHERE source = 'shinigami'")[0]['cnt']
total_api_chapters = sum(len(s.get("chapters", [])) for s in scraped)
print(f"\n=== Summary ===")
print(f"API series: {len(scraped)}, total chapters in API: {total_api_chapters}")
print(f"DB total shinigami rows: {total_db}")
