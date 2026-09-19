from app.db import get_supabase
sb = get_supabase()

# Check dispatch_claims
print("=== dispatch_claims ===")
claims = sb.table('dispatch_claims').select('*').execute().data or []
print(f"Total: {len(claims)}")
for r in claims:
    print(f"  {r}")

# Check recent dispatch_history (last 10)
print("\n=== dispatch_history (last 10) ===")
dh = sb.table('dispatch_history').select('*').order('sent_at', desc=True).limit(10).execute().data or []
for r in dh:
    print(f"  {r.get('title_key','?')[:40]:<40} {r.get('chapter_title','?')[:15]:<15} {r.get('source','?'):<10} fcfs={r.get('fcfs_key','?')[:40]}")
