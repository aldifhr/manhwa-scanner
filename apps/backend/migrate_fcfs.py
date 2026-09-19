from app.db import get_supabase
sb = get_supabase()

# Update all dispatch_history fcfs_key from old format to new format
# Old: "the dark swordsman returns#65" (spaces)
# New: "the-dark-swordsman-returns#65" (dashes)

# Get all rows with fcfs_key containing spaces
rows = sb.table('dispatch_history').select('id, fcfs_key').execute().data or []
updated = 0
for r in rows:
    old_key = r.get('fcfs_key', '')
    if not old_key or ' ' not in old_key:
        continue
    # Convert: "the dark swordsman returns#65" → "the-dark-swordsman-returns#65"
    parts = old_key.rsplit('#', 1)
    if len(parts) != 2:
        continue
    title_part, ch_part = parts
    # Apply same normalization as slugify_title_key
    import re, html
    t = html.unescape(title_part.lower())
    t = re.sub(r'[^a-z0-9]+', ' ', t).strip()
    t = t.replace(' ', '-')
    new_key = f"{t}#{ch_part}"
    
    sb.table('dispatch_history').update({'fcfs_key': new_key}).eq('id', r['id']).execute()
    updated += 1

print(f"Updated {updated} fcfs_key entries")
