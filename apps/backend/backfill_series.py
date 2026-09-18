import os, sys, time

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

with open(".env") as f:
    for line in f:
        if line.startswith("DATABASE_URL=") and not line.startswith("#"):
            os.environ["DATABASE_URL"] = line.strip().split("=", 1)[1]
            break

import psycopg2
from psycopg2.extras import RealDictCursor
from app.scrapers.shinigami import get_shinigami_chapters
from app.config import settings

conn = psycopg2.connect(os.environ["DATABASE_URL"], sslmode="require")
conn.autocommit = True
cur = conn.cursor(cursor_factory=RealDictCursor)

series = [
    ("the-maid-with-a-child", "35c3d371-dadf-40b3-83d7-745ad3436477"),
    ("i-may-be-a-beginner-but-i-m-actually-a-level-99-overpowered-player", "950e0099-7a58-4d29-b1ef-40cb5b95c175"),
]

for title_key, mid in series:
    print(f"\n=== Backfilling {title_key} ===")
    chapters = get_shinigami_chapters(mid, per_page=100)
    print(f"  Fetched {len(chapters)} chapters from API")
    
    inserted = 0
    for ch in chapters:
        num = ch.get("chapter_number") or ch.get("number") or ch.get("chapter")
        ch_id = ch.get("chapter_id") or ch.get("id")
        ch_url = f"{settings.SHINIGAMI_PUBLIC_BASE}/chapter/{ch_id}" if ch_id else ch.get("url")
        if not ch_url or num is None:
            continue
        
        try:
            num = float(num)
        except (ValueError, TypeError):
            continue
        
        cur.execute("""
            INSERT INTO recent_chapters (chapter_url, title_key, title, chapter, source, chapter_num, series_url, created_at, updated_time)
            VALUES (%s, %s, %s, %s, 'shinigami', %s, %s, NOW(), NOW())
            ON CONFLICT (chapter_url) DO UPDATE SET updated_time = NOW()
            RETURNING id
        """, (
            ch_url,
            title_key,
            title_key.replace("-", " ").title(),
            str(num),
            num,
            f"{settings.SHINIGAMI_PUBLIC_BASE}/series/{mid}"
        ))
        if cur.fetchone():
            inserted += 1
    
    print(f"  Inserted/updated {inserted} chapters")
    time.sleep(1)

print("\n=== Verification ===")
for title_key, mid in series:
    cur.execute("SELECT COUNT(*) as c FROM recent_chapters WHERE title_key = %s", (title_key,))
    print(f"  {title_key}: {cur.fetchone()['c']} chapters")

conn.close()
print("\nDone!")
