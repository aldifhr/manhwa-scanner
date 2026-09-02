import os, psycopg2
from dotenv import load_dotenv
load_dotenv("/root/projects/manhwa-backend/.env")
conn = psycopg2.connect(os.getenv("DATABASE_URL")); conn.autocommit = True
cur = conn.cursor()
cur.execute("""
SELECT w.title_key, w.source,
      (SELECT MAX(rc.chapter_num) FROM recent_chapters rc
        WHERE rc.title_key = w.title_key AND rc.source = w.source) AS mx
FROM whitelist w WHERE w.latest_sent_chapter IS NULL""")
n = 0
for tk, src, mx in cur.fetchall():
    if mx is None:
        continue
    cur.execute(
        "UPDATE whitelist SET latest_sent_chapter=%s, latest_chapter=%s WHERE title_key=%s AND source=%s",
        (mx, mx, tk, src),
    )
    n += 1
print("markers updated:", n)
conn.close()
