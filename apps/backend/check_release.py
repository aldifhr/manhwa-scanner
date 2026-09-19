from app.db import get_supabase
sb = get_supabase()

print("=== API vs DB comparison ===")
print(f"{'Ch':<6} {'API release_date':<22} {'DB updated_time':<22} {'Match?'}")
print("-" * 60)

api_data = [
    (118, "2026-09-19T07:35:42Z"),
    (117, "2026-09-12T16:10:04Z"),
    (116, "2026-09-07T20:51:28Z"),
    (115, "2026-09-01T01:10:04Z"),
    (114, "2026-08-24T16:31:47Z"),
    (113, "2026-08-24T16:01:12Z"),
    (112, "2026-08-11T08:55:53Z"),
]

for ch_num, api_date in api_data:
    # Convert API date to comparable format
    from datetime import datetime
    api_dt = datetime.fromisoformat(api_date.replace("Z", "+00:00"))
    api_str = api_dt.strftime("%Y-%m-%d %H:%M")
    
    # Get from DB
    db = sb.table('recent_chapters').select('updated_time').eq('chapter_num', ch_num).ilike('title_key', 'i-was-immediately-mistaken-for-a-monster-genius-actor').execute().data or []
    if db:
        db_date = db[0].get('updated_time', '')
        db_str = db_date[:16] if db_date else 'N/A'
        match = "YES" if api_str == db_str else "NO"
        print(f"ch.{ch_num:<3} {api_str:<20} {db_str:<20} {match}")
    else:
        print(f"ch.{ch_num:<3} {api_str:<20} {'NOT IN DB':<20} N/A")

print()
print("=== Problem ===")
print("API shows ch.117 released 2026-09-12 (7 days ago)")
print("API shows ch.116 released 2026-09-07 (12 days ago)")
print("But DB updated_time = 2026-09-19 for BOTH → muncul di RSS 24h!")
print()
print("Fix: RSS filter harus pakai release_date dari API, bukan updated_time")
