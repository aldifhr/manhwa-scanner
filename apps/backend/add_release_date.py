"""Add release_date column to recent_chapters + backfill."""
import os
os.chdir('/root/projects/manhwa-scanner/apps/backend')

from app.db import get_supabase, q
sb = get_supabase()

# 1. Check if column exists
try:
    q("SELECT release_date FROM recent_chapters LIMIT 1")
    print("Column exists")
except Exception as e:
    if "does not exist" in str(e):
        # Add column
        q("ALTER TABLE recent_chapters ADD COLUMN release_date TIMESTAMPTZ")
        print("Column added")
    else:
        print(f"Error: {e}")
        raise

# 2. Backfill: release_date = updated_time where NULL
result = q("UPDATE recent_chapters SET release_date = updated_time WHERE release_date IS NULL")
print(f"Backfilled: {result}")

# 3. Verify
row = q("SELECT COUNT(*) as total, COUNT(release_date) as has_release FROM recent_chapters")
print(f"Total: {row[0]['total']}, Has release_date: {row[0]['has_release']}")
