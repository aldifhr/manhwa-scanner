from app.db import get_supabase
from app.services.fcfs import fcfs_key, claimed_fcfs_keys
from app.storage import whitelist as wl_store
from app.utils.text import normalize_title_key as _ntk
from app.cron import dispatch_mod
from datetime import datetime, timedelta, timezone

sb = get_supabase()
cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
rc = sb.table('recent_chapters').select('*').gte('updated_time', cutoff).execute().data or []
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

print(f'Pending: {len(final)}')

if final:
    # Map to dispatch format
    to_send = []
    for c in final:
        to_send.append({
            'title': c.get('title', ''),
            'chapter': str(c.get('chapter_num', '')),
            'url': c.get('chapter_url', ''),
            'title_key': c.get('title_key', ''),
            'source': c.get('source', ''),
            'origin': c.get('origin', ''),
            'cover': c.get('cover', ''),
            'updated_time': c.get('updated_time', ''),
            'series_url': c.get('series_url', ''),
        })
    
    # Clear stale claims first (older than 1 hour)
    sb.table('dispatch_claims').delete().lt('expires_at', datetime.now(timezone.utc).isoformat()).execute()
    
    channels = ['1528225292622102639', '1550542181964587078']
    sent = dispatch_mod.dispatch(to_send, channels, 'manual-fix', dry_run=False)
    print(f'Sent: {sent}')
