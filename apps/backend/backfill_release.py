"""Backfill release_date for existing rows and verify."""
import os
os.chdir('/root/projects/manhwa-scanner/apps/backend')

from app.db import get_supabase, q

# Check current state
before = q("SELECT COUNT(*) as total, COUNT(release_date) as has_release FROM recent_chapters")
print(f"Before: total={before[0]['total']}, has_release={before[0]['has_release']}")

# Backfill using raw SQL (Supabase update may not handle NULL cast well)
result = q("UPDATE recent_chapters SET release_date = updated_time WHERE release_date IS NULL RETURNING chapter_url")
print(f"Updated: {len(result) if result else 0} rows")

# Verify
after = q("SELECT COUNT(*) as total, COUNT(release_date) as has_release FROM recent_chapters")
print(f"After: total={after[0]['total']}, has_release={after[0]['has_release']}")

# Check the specific title
rows = q("SELECT chapter_num, release_date, updated_time FROM recent_chapters WHERE title_key = 'i-was-immediately-mistaken-for-a-monster-genius-actor' AND chapter_num IN (116, 117, 118)")
for r in rows:
    print(f"  ch.{r['chapter_num']:<5} release={str(r['release_date'])[:19]:<20} updated={str(r['updated_time'])[:19]}")
