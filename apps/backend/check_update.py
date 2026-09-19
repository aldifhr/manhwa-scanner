from app.db import get_supabase, q
sb = get_supabase()

# Check release_date for shinigami chapters
rows = q("SELECT chapter_num, release_date, updated_time FROM recent_chapters WHERE title_key = 'i-was-immediately-mistaken-for-a-monster-genius-actor' AND source = 'shinigami' AND chapter_num IN (116, 117, 118)")
for r in rows:
    print(f"  ch.{r['chapter_num']:<5} release={str(r['release_date'])[:19] if r['release_date'] else 'NULL':<20} updated={str(r['updated_time'])[:19]}")
