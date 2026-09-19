from app.db import get_supabase
sb = get_supabase()

# Cek recent_chapters untuk title ini
rc = sb.table('recent_chapters').select('title_key, chapter_num, updated_time, source').ilike('title_key', 'i-was-immediately-mistaken-for-a-monster-genius-actor').execute().data or []
print(f"Recent chapters: {len(rc)}")
for r in rc:
    print(f"  ch.{r.get('chapter_num','?'):<5} {r.get('updated_time','?')[:19]}  src={r.get('source','?')}")
