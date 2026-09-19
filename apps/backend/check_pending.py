from app.db import get_supabase
from app.services.fcfs import fcfs_key, claimed_fcfs_keys
from app.storage import whitelist as wl_store
from app.utils.text import normalize_title_key as _ntk
from datetime import datetime, timedelta, timezone

sb = get_supabase()
cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
rc = sb.table('recent_chapters').select('id,title_key,source,chapter,chapter_num,title,chapter_url,origin').gte('updated_time', cutoff).execute().data or []
wl = wl_store.load_whitelist()
wl_keys = {(_ntk(str(w.get('title_key',''))), w.get('source','')) for w in wl}
whitelisted = [c for c in rc if (_ntk(str(c.get('title_key',''))), c.get('source','')) in wl_keys]

ceil = {}
for w in wl:
    tk = _ntk(str(w.get('title_key','')))
    src = w.get('source','')
    try:
        ls = float(w.get('latest_sent_chapter') or 0)
    except:
        ls = 0
    if tk:
        ceil[(tk, src)] = max(ceil.get((tk, src), 0), ls)

pending = []
for c in whitelisted:
    tk = _ntk(str(c.get('title_key','')))
    src = c.get('source','')
    c_ceil = ceil.get((tk, src), 0)
    try:
        ch = float(c.get('chapter_num') or c.get('chapter') or 0)
    except:
        ch = 0
    if c_ceil and ch <= c_ceil:
        continue
    pending.append(c)

keys = [fcfs_key(c.get('title',''), c.get('chapter','')) for c in pending]
claimed = claimed_fcfs_keys(keys) if keys else set()
final = [c for i, c in enumerate(pending) if keys[i] not in claimed]

print(f'Pending chapters: {len(final)}')
for c in final:
    print(f"  {c.get('title','?')[:35]:<36} {c.get('source','?'):<10} ch.{c.get('chapter_num','?')}")
