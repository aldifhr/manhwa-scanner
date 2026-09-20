"""Fix wrong release_date for existing shinigami rows."""
import os
os.chdir('/root/projects/manhwa-scanner/apps/backend')

from app.db import q

# Update wrong release_date for known problematic titles
# Pattern: release_date = updated_time (series-level) but chapter is older

updates = [
    # Top Tier Providence: ch.277 was released on 2026-09-07, not 2026-09-19
    ("top-tier-providence", 277, "2026-09-07T01:35:14"),
    # I Was Immediately Mistaken...
    ("i-was-immediately-mistaken-for-a-monster-genius-actor", 117, "2026-09-12T16:10:04"),
    ("i-was-immediately-mistaken-for-a-monster-genius-actor", 116, "2026-09-07T20:51:28"),
]

for title_key, ch_num, correct_date in updates:
    result = q("UPDATE recent_chapters SET release_date = %s WHERE title_key = %s AND source = 'shinigami' AND chapter_num = %s AND release_date != %s", [correct_date, title_key, ch_num, correct_date])
    print(f"Updated {title_key} ch.{ch_num} -> {correct_date}")

# Verify
print("\n=== Verify ===")
rows = q("SELECT title_key, chapter_num, release_date FROM recent_chapters WHERE title_key IN ('top-tier-providence', 'i-was-immediately-mistaken-for-a-monster-genius-actor') AND source = 'shinigami' ORDER BY title_key, chapter_num")
for r in rows:
    print(f"  {r['title_key'][:35]:<36} ch.{r['chapter_num']:<5} release={str(r['release_date'])[:19] if r['release_date'] else 'NULL'}")
