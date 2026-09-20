import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import httpx

# Check "A Painter who draws dungeon"
url = "https://api.shngm.io/v1/manga/list?page=1&page_size=100&is_update=true&sort=latest&sort_order=desc"
r = httpx.get(url, timeout=10)
data = r.json().get("data", [])

for s in data:
    title = s.get("title", "")
    if "painter" in title.lower() and "dungeon" in title.lower():
        print(f"=== {title} ===")
        print(f"manga_id: {s.get('manga_id')}")
        print(f"latest_chapter_time: {s.get('latest_chapter_time')}")
        print(f"chapters count: {len(s.get('chapters', []))}")
        for ch in s.get("chapters", [])[:10]:
            print(f"  ch.{ch.get('chapter_number'):<5} created_at={ch.get('created_at')}")
        break
