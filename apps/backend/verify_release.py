"""Verify release_date is properly set for new shinigami chapters."""
import os
os.chdir('/root/projects/manhwa-scanner/apps/backend')

from app.db import get_supabase
sb = get_supabase()

# Check if recent chapters have release_date
rows = sb.table('recent_chapters').select('chapter_url, chapter_num, title_key, release_date, updated_time').ilike('title_key', 'i-was-immediately-mistaken-for-a-monster-genius-actor').limit(10).execute().data or []
for r in rows:
    print(f"  ch.{r.get('chapter_num','?'):<5} release={r.get('release_date','')[:19] if r.get('release_date') else 'NULL':<20} updated={r.get('updated_time','')[:19]:<20}")
