import os, sys, psycopg2
from dotenv import load_dotenv
load_dotenv("/root/projects/manhwa-backend/.env")
sys.path.insert(0, "/root/projects/manhwa-backend")
conn = psycopg2.connect(os.getenv("DATABASE_URL"))
conn.autocommit = True
cur = conn.cursor()
# Fix inverted markers: latest_chapter must be >= latest_sent_chapter.
# Use the max of both, then max with scraped if available.
cur.execute("""
SELECT w.title_key, w.source, w.latest_sent_chapter,
      (SELECT MAX(rc.chapter_num) FROM recent_chapters rc
        WHERE rc.title_key = w.title_key AND rc.source = w.source)
FROM whitelist w
WHERE w.latest_sent_chapter IS NOT NULL AND w.latest_chapter IS NOT NULL
  AND w.latest_chapter < w.latest_sent_chapter""")
fixed = 0
for tk, src, sent, scraped in cur.fetchall():
    new_lc = max(sent, float(scraped) if scraped is not None else sent)
    cur.execute(
        "UPDATE whitelist SET latest_chapter=%s WHERE title_key=%s AND source=%s",
        (new_lc, tk, src),
    )
    fixed += 1
    print(f"fixed {tk[:40]} ({src}): latest_chapter -> {new_lc}")
print("total fixed:", fixed)
conn.close()
