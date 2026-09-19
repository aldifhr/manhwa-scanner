import psycopg2, httpx
conn=psycopg2.connect('postgresql://postgres:postgres@localhost:5432/manhwa')
cur=conn.cursor()
cur.execute("select id, title, chapter, updated_time from recent_chapters where title ilike '%Lazy Sovereign%' order by id desc")
print("DB by id desc:")
for r in cur.fetchall():
    print(r)
cur.execute("select id, title, chapter, updated_time from recent_chapters where source='shinigami' order by id desc limit 10")
print("\nDB top 10 by id desc:")
for r in cur.fetchall():
    print(r)
cur.execute("select id, title, chapter, updated_time from recent_chapters where source='shinigami' order by updated_time desc limit 10")
print("\nDB top 10 by updated_time desc:")
for r in cur.fetchall():
    print(r)

# fetch via backend
for url in [
    "http://127.0.0.1:8000/api/v1/reader/rss?limit=200&group=false",
    "http://127.0.0.1:8000/api/rss?limit=200&group=false",
]:
    try:
        r=httpx.get(url, timeout=10)
        j=r.json()
        data=j.get('data',{})
        results=data.get('results',[]) if isinstance(data, dict) else []
        print(f"\n{url} -> {len(results)} results")
        found=[x for x in results if 'Lazy Sovereign' in x.get('title','')]
        print(f"Lazy Sovereign in results: {len(found)}")
        for f in found:
            print(f"  {f.get('title')} ch {f.get('chapter')} {f.get('updated_time')}")
        # check hasMore
        print(f"hasMore {data.get('hasMore')}, total {data.get('total')}")
    except Exception as e:
        print(url, e)

# check via frontend proxy with cache bust
try:
    r=httpx.get("http://localhost:3000/api/v1/rss?page=1&limit=100&group=false&x=123", timeout=10)
    j=r.json()
    data=j.get('data',{})
    results=data.get('results',[])
    print(f"\nfrontend proxy with cache bust -> {len(results)}")
    found=[x for x in results if 'Lazy Sovereign' in x.get('title','')]
    print(f"Lazy Sovereign via frontend: {len(found)}")
except Exception as e:
    print(e)

conn.close()
