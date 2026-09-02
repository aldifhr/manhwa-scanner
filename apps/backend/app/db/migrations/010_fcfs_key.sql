ALTER TABLE dispatch_history ADD COLUMN IF NOT EXISTS fcfs_key text;

CREATE INDEX IF NOT EXISTS idx_dispatch_history_fcfs_key
  ON dispatch_history (fcfs_key);

UPDATE dispatch_history
SET fcfs_key = lower(regexp_replace(
    coalesce(chapter_title, '') || '#' || coalesce(title_key, ''),
    '[^a-z0-9#]', ' ', 'g'))
WHERE fcfs_key IS NULL;
