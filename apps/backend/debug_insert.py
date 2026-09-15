#!/usr/bin/env python3
"""Trace batch_insert for specific title_key."""
import sys
sys.path.insert(0, '.')

from app.db import get_supabase
from app.utils.text import slugify_title_key

# Simulate what happens in batch_insert
title = "Sovereign Of A Hundred Blades: Heir To The Strongest Style"
title_key = slugify_title_key(title)
print(f'title_key: {title_key}')

# Check existing in DB
sb = get_supabase()
res = sb.table('recent_chapters').select('chapter_url,title_key,source,chapter_num').eq('title_key', title_key).execute()
print(f'Existing rows: {len(res.data)}')
for r in res.data or []:
    print(f'  {r}')

# Simulate a row insert
row = {
    'title_key': title_key,
    'source': 'shinigami',
    'chapter': '6',
    'chapter_num': 6.0,
    'chapter_url': 'https://11.shinigami.asia/chapter/bf21f6fc-da3c-4def-a70a-6c30f10d93c9',
    'series_url': 'https://11.shinigami.asia/series/922a9dff-2e72-4611-a465-a4acc38edae6',
    'cover': 'https://assets.shngm.id/thumbnail/cover/banner_1779113560638_3fduxr.jpg',
    'rating': 8.5,
    'description': 'test',
    'genres': ['Action'],
    'type': 'manga',
    'origin': 'JP',
    'updated_time': '2026-09-15T03:11:45+00:00',
}

# Try insert
try:
    result = sb.table('recent_chapters').upsert([row], on_conflict='chapter_url').execute()
    print(f'Upsert result: {result.data}')
except Exception as e:
    print(f'Upsert failed: {e}')
