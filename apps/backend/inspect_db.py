import psycopg2
conn=psycopg2.connect('postgresql://postgres:postgres@localhost:5432/manhwa')
cur=conn.cursor()
cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
tables=[r[0] for r in cur.fetchall()]
print(f"Total tables: {len(tables)}")
for t in tables:
    cur.execute(f"SELECT count(*) FROM \"{t}\"")
    cnt=cur.fetchone()[0]
    print(f" - {t}: {cnt} rows")
print("\n== schema_migrations ==")
cur.execute("SELECT filename FROM schema_migrations ORDER BY filename")
for r in cur.fetchall():
    print(r[0])
print("\n== sample recent_chapters (5) ==")
try:
    cur.execute("SELECT title_key, title, chapter, source, updated_time FROM recent_chapters ORDER BY updated_time DESC LIMIT 5")
    for r in cur.fetchall():
        print(r)
except Exception as e:
    print("recent_chapters error:", e)
print("\n== sample whitelist (5) ==")
try:
    cur.execute("SELECT title_key, title, source FROM whitelist LIMIT 5")
    for r in cur.fetchall():
        print(r)
except Exception as e:
    print("whitelist error:", e)
print("\n== sample dispatch_history (5) ==")
try:
    cur.execute("SELECT title_key, chapter_title, source, sent_at FROM dispatch_history LIMIT 5")
    for r in cur.fetchall():
        print(r)
except Exception as e:
    print("dispatch_history error:", e)
conn.close()
