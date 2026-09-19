import os
os.chdir('/root/projects/manhwa-scanner/apps/backend')

from app.config import settings
from app.db import get_supabase
from datetime import datetime, timedelta, timezone

print(f"RSS_LOOKBACK_HOURS: {settings.RSS_LOOKBACK_HOURS}")

sb = get_supabase()
now = datetime.now(timezone.utc)
cutoff = (now - timedelta(hours=settings.RSS_LOOKBACK_HOURS)).strftime('%Y-%m-%dT%H:%M:%S+00:00')

print(f"Now: {now.isoformat()}")
print(f"Cutoff: {cutoff}")

# Check if ch 113-115 are in the filtered results
rc = sb.table('recent_chapters').select('title_key, chapter_num, updated_time').ilike('title_key', 'i-was-immediately-mistaken-for-a-monster-genius-actor').gte('updated_time', cutoff).execute().data or []
print(f"\nIn RSS filter (>= cutoff): {len(rc)}")
for r in rc:
    print(f"  ch.{r.get('chapter_num','?'):<5} {r.get('updated_time','?')[:19]}")

# Check the actual updated_time for these
print("\nAll ch.113-118 for this title:")
all_ch = sb.table('recent_chapters').select('chapter_num, updated_time').ilike('title_key', 'i-was-immediately-mistaken-for-a-monster-genius-actor').in_('chapter_num', [113,114,115,116,117,118]).execute().data or []
for r in all_ch:
    print(f"  ch.{r.get('chapter_num','?'):<5} {r.get('updated_time','?')[:19]}")
