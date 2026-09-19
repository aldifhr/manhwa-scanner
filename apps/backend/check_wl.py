from app.db import get_supabase
from datetime import datetime, timedelta, timezone

sb = get_supabase()
cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S+00:00')

# Whitelisted baru (1 jam terakhir)
wl = sb.table('whitelist').select('*').gte('created_at', cutoff).execute().data or []
print(f'Whitelist baru (1 jam): {len(wl)}')
for r in wl:
    print(f"  {r.get('title_key','?'):<50} {r.get('source','?'):<12} {r.get('title','?')[:40]}")
