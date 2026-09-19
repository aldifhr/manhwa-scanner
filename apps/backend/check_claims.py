import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from app.db import get_supabase
sb = get_supabase()
claims = sb.table('dispatch_claims').select('*').execute().data or []
print(f'dispatch_claims: {len(claims)}')
for r in claims[:10]:
    print(f"  {r}")
