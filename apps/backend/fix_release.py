"""Debug: check release_date state and fix."""
import os
os.chdir('/root/projects/manhwa-scanner/apps/backend')

from app.db import get_supabase, q
sb = get_supabase()

# Check state
before = q("SELECT COUNT(*) as total, COUNT(release_date) as has_release FROM recent_chapters")
print(f"Before fix: total={before[0]['total']}, has_release={before[0]['has_release']}")

# Fix NULL release_date
result = q("UPDATE recent_chapters SET release_date = updated_time WHERE release_date IS NULL")
print(f"Fixed: {len(result) if result else 0} rows")

# Verify
after = q("SELECT COUNT(*) as total, COUNT(release_date) as has_release FROM recent_chapters")
print(f"After fix: total={after[0]['total']}, has_release={after[0]['has_release']}")

# Check the specific title
rows = q("SELECT chapter_num, release_date, updated_time FROM recent_chapters WHERE title_key = 'top-tier-providence' LIMIT 5")
for r in rows:
    print(f"  ch.{r['chapter_num']:<5} release={str(r['release_date'])[:19]:<20} updated={str(r['updated_time'])[:19]}")
