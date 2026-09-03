import os, psycopg2
from dotenv import load_dotenv
load_dotenv("/root/projects/manhwa-backend/.env")
conn = psycopg2.connect(os.getenv("DATABASE_URL"))
cur = conn.cursor()
res = []
def check(n, ok, detail=""):
    res.append((n, "PASS" if ok else "FAIL", detail))

cur.execute("""SELECT COUNT(*),
  COUNT(*) FILTER (WHERE series_url IS NULL OR series_url=''),
  COUNT(*) FILTER (WHERE origin NOT IN ('KR','CN','JP')),
  COUNT(*) FILTER (WHERE rating IS NOT NULL AND rating<>'' AND (CAST(rating AS float)<1 OR CAST(rating AS float)>10)),
  COUNT(*) FILTER (WHERE latest_sent_chapter IS NOT NULL AND latest_chapter IS NOT NULL AND latest_chapter < latest_sent_chapter)
FROM whitelist""")
t, e, bo, br, inv = cur.fetchone()
check("WL: no empty series_url", e == 0, f"{e} empty")
check("WL: origin valid KR/CN/JP", bo == 0, f"{bo} bad")
check("WL: rating 1-10", br == 0, f"{br} bad")
check("WL: latest_chapter >= sent", inv == 0, f"{inv} inverted")

cur.execute("""SELECT COUNT(*) FROM (
  SELECT LOWER(title_key), source, COUNT(*) c FROM whitelist GROUP BY 1,2 HAVING COUNT(*)>1) x""")
d = cur.fetchone()[0]
check("WL: no same key+source dupes", d == 0, f"{d} dup groups")

cur.execute("""SELECT COUNT(*) FROM whitelist w
WHERE w.latest_sent_chapter IS NULL AND NOT EXISTS (
  SELECT 1 FROM recent_chapters rc WHERE rc.title_key=w.title_key AND rc.source=w.source)""")
orph = cur.fetchone()[0]
check("WL: dormant count sane", orph < 60, f"{orph} never-scraped rows")

cur.execute("""SELECT COUNT(*),
  COUNT(*) FILTER (WHERE chapter_num IS NULL),
  COUNT(*) FILTER (WHERE title_key IS NULL OR title_key=''),
  COUNT(*) FILTER (WHERE updated_time < now() - interval '48 hours')
FROM recent_chapters""")
rc, nonum, notk, stale = cur.fetchone()
check("RC: all have chapter_num", nonum == 0, f"{nonum} null")
check("RC: all have title_key", notk == 0, f"{notk} empty")
check("RC: prune window working", stale == 0, f"{stale} older than 48h")

cur.execute("""SELECT COUNT(*) FROM (
  SELECT w.title_key, w.source FROM whitelist w WHERE w.latest_sent_chapter IS NOT NULL
  GROUP BY 1,2
  HAVING (SELECT MAX(rc.chapter_num) FROM recent_chapters rc
          WHERE rc.title_key=w.title_key AND rc.source=w.source)
         - MAX(w.latest_sent_chapter) > 1) t""")
gaps = cur.fetchone()[0]
check("GAPS: zero chapter gaps", gaps == 0, f"{gaps} series gapped")

cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE channel_id='' OR channel_id IS NULL) FROM guild_settings")
gs, badch = cur.fetchone()
check("GS: all guilds have channels", gs > 0 and badch == 0, f"{gs} guilds, {badch} bad")

cur.execute("SELECT source, status FROM source_health")
sh = dict(cur.fetchall())
check("SRC: both sources healthy", sh.get("ikiru") == "healthy" and sh.get("shinigami") == "healthy", str(sh))

cur.execute("SELECT COUNT(*), COUNT(*) FILTER (WHERE sent_at > now() - interval '24 hours') FROM dispatch_history")
dh, dh24 = cur.fetchone()
check("DH: history populated", dh > 100 and dh24 > 0, f"{dh} total, {dh24} last 24h")

print(f"{'CHECK':44s} RESULT  DETAIL")
print("-" * 95)
fails = 0
for n, r, d in res:
    if r == "FAIL":
        fails += 1
    print(f"{n[:44]:44s} {r:5s}   {d[:42]}")
print(f"\nTOTAL: {len(res)} | PASS {len(res)-fails} | FAIL {fails}")
conn.close()
