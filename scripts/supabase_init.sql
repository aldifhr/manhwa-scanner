-- Supabase Initialization Script for Manhwa-Scrap-Discord

-- 1. Create a table to track chapter history (acting as permanent deduplication)
CREATE TABLE IF NOT EXISTS chapter_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title_key VARCHAR NOT NULL,
    chapter_key VARCHAR NOT NULL,
    manga_title VARCHAR,
    chapter_text VARCHAR,
    source VARCHAR,
    channel_id VARCHAR,
    dispatched_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT unique_chapter_dispatch UNIQUE(title_key, chapter_key, channel_id)
);

-- 2. Create index to speed up dedupe lookups
CREATE INDEX idx_chapter_history_lookup ON chapter_history(title_key, chapter_key, channel_id);

-- Optional: Create a table for manga metadata if you want to store it permanently
CREATE TABLE IF NOT EXISTS mangas (
    title_key VARCHAR PRIMARY KEY,
    title VARCHAR,
    source VARCHAR,
    synopsis TEXT,
    genres TEXT[],
    cover_url VARCHAR,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
