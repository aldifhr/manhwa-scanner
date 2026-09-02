# SQL Architecture — scanner.aldifhr.fun

**Database:** PostgreSQL (Supabase pooler, psycopg2)
**Project:** manhwa-backend
**Last Updated:** 2026-09-03
**Total Tables:** 10 (+2 active: series_meta, continue_reading) + 2 internal (dispatch_claims, failed_dispatches) = 12 physical, 8 core
**Total Rows:** ~17,500+

---

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MANHWA TRACKER DATABASE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐       │
│  │    whitelist     │     │  recent_chapters │     │ dispatch_history│       │
│  │   (343 rows)    │     │   (329 rows)     │     │   (922 rows)    │       │
│  ├─────────────────┤     ├─────────────────┤     ├─────────────────┤       │
│  │ PK: title_key   │◄────│ FK: title_key    │     │ PK: chapter_url │       │
│  │    + source     │     │    (indexed)     │     │ FK: title_key   │       │
│  └────────┬────────┘     └────────┬────────┘     └────────┬────────┘       │
│           │                       │                       │                 │
│           │    ┌──────────────────┘                       │                 │
│           │    │                                          │                 │
│           ▼    ▼                                          ▼                 │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐       │
│  │  cron_run_status │     │ dashboard_snap  │     │   source_health  │       │
│  │  (13,235 rows)   │     │   (1 row)       │     │   (2 rows)       │       │
│  ├─────────────────┤     ├─────────────────┤     ├─────────────────┤       │
│  │ PK: id (BIGSERIAL)│    │ PK: id          │     │ PK: source      │       │
│  │ IDX: created_at  │     │ CHECK (id=1)    │     │                 │       │
│  └─────────────────┘     └─────────────────┘     └─────────────────┘       │
│                                                                             │
│  ┌─────────────────┐     ┌─────────────────┐                               │
│  │  excluded_titles │     │  guild_settings  │                               │
│  │   (14 rows)     │     │   (1 row)        │                               │
│  ├─────────────────┤     ├─────────────────┤                               │
│  │ PK: title_key   │     │ PK: guild_id    │                               │
│  │    + source     │     │                 │                               │
│  └─────────────────┘     └─────────────────┘                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Table Catalog (12 Tables — 8 core + 4 support)

### 1. whitelist (343 rows)

**Purpose:** Series yang di-track untuk notifikasi Discord

| Column              | Type             | Nullable | Default           | Description                  |
| ------------------- | ---------------- | -------- | ----------------- | ---------------------------- |
| title_key           | text             | **NO**   | -                 | Normalized title identifier  |
| title               | text             | YES      | -                 | Display title                |
| source              | text             | **NO**   | -                 | ikiru / shinigami            |
| cover               | text             | YES      | -                 | Cover image URL              |
| status              | text             | YES      | -                 | ongoing / completed          |
| rating              | text             | YES      | -                 | Rating value                 |
| genres              | jsonb            | YES      | -                 | Genre list                   |
| description         | text             | YES      | -                 | Series synopsis              |
| series_url          | text             | YES      | -                 | Source series page           |
| origin              | text             | YES      | -                 | KR / JP / CN                 |
| type                | text             | YES      | -                 | manhwa / manga / manhua      |
| latest_sent_chapter | integer          | YES      | -                 | Last chapter sent to Discord |
| latest_chapter      | double precision | YES      | -                 | Current max chapter          |
| url                 | text             | YES      | -                 | Alternative URL              |
| created_at          | timestamptz      | NO       | now()             | Creation timestamp           |
| updated_at          | timestamptz      | YES      | -                 | Last update                  |
| id                  | uuid             | NO       | gen_random_uuid() | Surrogate PK (mig 038)       |

**Constraints:** PRIMARY KEY (id), UNIQUE (title_key, source), NOT NULL (id, title_key, source, created_at)

---

### 2. recent_chapters (329 rows)

**Purpose:** Scraped chapters dari sources (24h rolling window)

| Column       | Type        | Nullable | Default      | Description             |
| ------------ | ----------- | -------- | ------------ | ----------------------- |
| id           | bigint      | NO       | nextval(...) | Auto-increment PK       |
| chapter_url  | text        | **NO**   | -            | Unique chapter URL      |
| title_key    | text        | **NO**   | -            | Normalized title        |
| title        | text        | YES      | -            | Display title           |
| chapter      | text        | YES      | -            | Chapter label           |
| chapter_num  | numeric     | YES      | -            | Numeric chapter #       |
| source       | text        | YES      | -            | ikiru / shinigami       |
| cover        | text        | YES      | -            | Cover URL               |
| origin       | text        | YES      | -            | KR / JP / CN            |
| series_url   | text        | YES      | -            | Series page URL         |
| description  | text        | YES      | -            | Chapter description     |
| type         | text        | YES      | -            | manhwa / manga / manhua |
| created_at   | timestamptz | NO       | now()        | Scrape time             |
| updated_time | timestamptz | YES      | -            | Source update time      |

**Constraints:** UNIQUE (chapter_url), CHECK (source IN ('ikiru', 'shinigami')), NOT NULL (id, chapter_url, title_key, created_at)
**Indexes:** idx_recent_chapters_created_at (created_at DESC), idx_recent_chapters_title_key (title_key), idx_recent_chapters_source (source), idx_recent_chapters_created_at_source (created_at DESC, source)

---

### 3. dispatch_history (922 rows)

**Purpose:** Audit trail chapter yang sudah dikirim ke Discord

| Column        | Type        | Nullable | Default      | Description            |
| ------------- | ----------- | -------- | ------------ | ---------------------- |
| chapter_url   | text        | **NO**   | -            | Sent chapter URL       |
| title_key     | text        | YES      | -            | Normalized title       |
| source        | text        | YES      | -            | ikiru / shinigami      |
| chapter_title | text        | YES      | -            | Chapter display name   |
| fcfs_key      | text        | YES      | -            | FCFS dedup key         |
| cover         | text        | YES      | -            | Cover URL              |
| series_url    | text        | YES      | -            | Series page            |
| sent_at       | timestamptz | YES      | -            | Send timestamp         |
| created_at    | timestamptz | NO       | now()        | Record creation        |
| id            | bigint      | NO       | nextval(...) | Surrogate PK (mig 038) |

**Constraints:** PRIMARY KEY (id), UNIQUE (chapter_url), UNIQUE (fcfs_key) WHERE fcfs_key IS NOT NULL, NOT NULL (id, chapter_url, created_at)
**Indexes:** idx_dispatch_history_sent_at (sent_at DESC), idx_dispatch_history_fcfs_key (fcfs_key)

---

### 4. excluded_titles (14 rows)

**Purpose:** Title yang di-hide dari RSS feed

| Column     | Type        | Nullable | Default           | Description             |
| ---------- | ----------- | -------- | ----------------- | ----------------------- |
| title_key  | text        | **NO**   | -                 | Normalized title        |
| title      | text        | YES      | -                 | Display title           |
| source     | text        | **NO**   | 'all'             | ikiru / shinigami / all |
| cover      | text        | YES      | -                 | Cover URL               |
| series_url | text        | YES      | -                 | Series page             |
| created_at | timestamptz | YES      | now()             | Creation time           |
| id         | uuid        | NO       | gen_random_uuid() | Surrogate PK (mig 038)  |

**Constraints:** PRIMARY KEY (id), UNIQUE (title_key, source), NOT NULL (id, title_key, source)

---

### 5. cron_run_status (13,235 rows)

**Purpose:** Audit trail tiap cron run

| Column        | Type        | Nullable | Default      | Description       |
| ------------- | ----------- | -------- | ------------ | ----------------- |
| id            | bigint      | **NO**   | nextval(...) | Auto-increment PK |
| status        | text        | YES      | -            | ok / error        |
| chapters_sent | integer     | YES      | -            | Total sent        |
| matched       | integer     | YES      | -            | Total matched     |
| duration      | numeric     | YES      | -            | Runtime seconds   |
| created_at    | timestamptz | NO       | now()        | Run timestamp     |

**Constraints:** PK (id), NOT NULL (id, created_at)
**Indexes:** idx_cron_run_status_created_at (created_at DESC)
**Retention:** 90 days (auto-pruned in pipeline after each run)

---

### 6. dashboard_snapshot (1 row)

**Purpose:** Materialized dashboard payload (singleton)

| Column      | Type        | Nullable | Default | Description             |
| ----------- | ----------- | -------- | ------- | ----------------------- |
| id          | bigint      | NO       | -       | Singleton PK (always 1) |
| payload     | jsonb       | YES      | -       | Full dashboard data     |
| computed_at | timestamptz | **NO**   | -       | Last compute time       |

**Constraints:** PK (id), CHECK (id = 1), NOT NULL (computed_at)

---

### 7. source_health (2 rows)

**Purpose:** Health status per source (ikiru, shinigami)

| Column               | Type        | Nullable | Default | Description        |
| -------------------- | ----------- | -------- | ------- | ------------------ |
| source               | text        | NO       | -       | Source name        |
| status               | text        | YES      | -       | healthy / degraded |
| response_time_ms     | integer     | YES      | -       | Avg response time  |
| consecutive_failures | integer     | YES      | -       | Failure streak     |
| failures_today       | integer     | YES      | -       | Daily failures     |
| successes_today      | integer     | YES      | -       | Daily successes    |
| last_checked_at      | timestamptz | YES      | -       | Last probe         |
| last_success_at      | timestamptz | YES      | -       | Last success       |
| last_error           | text        | YES      | -       | Last error message |
| disabled_until       | timestamptz | YES      | -       | Cooldown expiry    |
| created_at           | timestamptz | YES      | -       | Creation           |
| updated_at           | timestamptz | YES      | -       | Last update        |

**Constraints:** PK (source), CHECK (source IN ('ikiru', 'shinigami')), NOT NULL (source)

---

### 8. guild_settings (1 row)

**Purpose:** Discord server settings

| Column        | Type        | Nullable | Default | Description         |
| ------------- | ----------- | -------- | ------- | ------------------- |
| guild_id      | text        | NO       | -       | Discord guild ID    |
| channel_id    | text        | YES      | -       | Target channel ID   |
| origin_filter | text        | YES      | ''      | KR / CN / JP filter |
| label         | text        | YES      | ''      | Guild display name  |
| created_at    | timestamptz | YES      | -       | Creation            |
| updated_at    | timestamptz | YES      | -       | Last update         |

**Constraints:** PK (guild_id)

---

### 9. series_meta (0 rows, lazy bootstrap)

**Purpose:** Static per-series metadata (rating, genres, description, cover, type) — single source of truth, lazy-filled via `_cached_series_meta()` `collect.py:101`

| Column      | Type         | Constraints                        |
| ----------- | ------------ | ---------------------------------- |
| title_key   | text PK part | FK → whitelist.title_key (logical) |
| source      | text PK part | ikiru/shinigami/voratoon           |
| rating      | float        | nullable                           |
| genres      | jsonb        | GIN                                |
| description | text         |                                    |
| cover       | text         |                                    |
| type        | text         | manhwa/manga/manhua                |
| origin      | text         | KR/CN/JP                           |

**Constraints:** PK (title_key, source), UNIQUE

### 10. continue_reading (0 rows, per-user)

**Purpose:** Continue-reading per `session_hash` (JWT `ikiru_dashboard_session`) `continue_reading.py:27`

| Column       | Type         | Notes                                              |
| ------------ | ------------ | -------------------------------------------------- |
| id           | bigserial PK |                                                    |
| session_hash | text UNIQUE  | sha256(cookie)[:16]                                |
| entries      | jsonb        | `{title_key: {chapter, chapterUrl...}}`            |
| updated_at   | double       | epoch `time.time()` — queried via `to_timestamp()` |

**Indexes:** `idx_continue_reading_entries_gin` `gin(jsonb_path_ops)` `043` + `idx_updated_at` DESC

### 11. dispatch_claims (ephemeral, 48h TTL)

**Purpose:** FCFS race guard `dispatch.py:187` `upsert(fcfs_key, expires=now+48h)` + `claim_recent_chapters_for_dispatch` `recent_chapters.py:385` `FOR UPDATE SKIP LOCKED`

### 12. failed_dispatches (retry queue)

**Purpose:** Transient Discord failures `dispatches.py:15` `POST /failed-dispatches?action=retry`

---

## Dropped Tables (4)

| Table              | Reason                                                     |
| ------------------ | ---------------------------------------------------------- |
| whitelist_entries  | Merged into whitelist                                      |
| canonical_series   | 39 rows, fuzzy matching not used (code now self-canonical) |
| series_max_chapter | 189 rows, duplicate of whitelist.latest_chapter            |
| manga_metadata     | Enriched into whitelist, table dropped                     |

**Note:** `dispatch_claims` and `failed_dispatches` are KEPT — they are actively
used (FCFS race-safety guard + retry queue). `continue_reading` is also KEPT
(0 rows but route still live).

---

## Index Map (21 Indexes)

| Table            | Index                                 | Type   | Columns                 | Purpose                   |
| ---------------- | ------------------------------------- | ------ | ----------------------- | ------------------------- |
| cron_run_status  | cron_run_status_pkey                  | PK     | id                      | Primary lookup            |
| cron_run_status  | idx_cron_run_status_created_at        | BTREE  | created_at DESC         | Fast latest lookup        |
| recent_chapters  | recent_chapters_chapter_url_key       | UNIQUE | chapter_url             | Dedup                     |
| recent_chapters  | idx_recent_chapters_created_at        | BTREE  | created_at DESC         | RSS 24h queries           |
| recent_chapters  | idx_recent_chapters_title_key         | BTREE  | title_key               | Whitelist join            |
| recent_chapters  | idx_recent_chapters_source            | BTREE  | source                  | Source filter             |
| recent_chapters  | idx_recent_chapters_created_at_source | BTREE  | created_at DESC, source | RSS per-source filter     |
| recent_chapters  | idx_recent_chapters_genres            | GIN    | genres                  | Genre filter              |
| dispatch_history | dispatch_history_chapter_url_key      | UNIQUE | chapter_url             | FCFS dedup                |
| dispatch_history | uq_dispatch_history_fcfs_key          | UNIQUE | fcfs_key                | FCFS enforcement          |
| dispatch_history | idx_dispatch_history_sent_at          | BTREE  | sent_at DESC            | Recent sends              |
| whitelist        | whitelist_title_key_source_key        | UNIQUE | title_key, source       | Whitelist check           |
| whitelist        | idx_whitelist_updated_at              | BTREE  | updated_at DESC         | Enrich queries            |
| excluded_titles  | excluded_titles_title_key_source_uniq | UNIQUE | title_key, source       | Exclude check             |
| excluded_titles  | idx_excluded_titles_title_key_source  | BTREE  | title_key, source       | RSS exclude filter        |
| excluded_titles  | idx_excluded_titles_created_at        | BTREE  | created_at DESC         | Recent excludes           |
| source_health    | source_health_pkey                    | PK     | source                  | Health lookup             |
| guild_settings   | guild_settings_pkey                   | PK     | guild_id                | Settings lookup           |
| continue_reading | idx_continue_reading_entries_gin      | GIN    | entries jsonb_path_ops  | Analytics most_read `043` |
| continue_reading | idx_continue_reading_updated_at       | BTREE  | updated_at DESC         | 24h/30d range             |
| series_meta      | series_meta_pkey                      | PK     | title_key, source       | Static meta lookup        |

---

## Key Workflows

### 1. Scrape Pipeline (rss-fetch)

```
collect_recent_chapters() → recent_chapters (INSERT)
    ↓
enrich_whitelist() → whitelist (UPDATE cover/rating/etc)
    ↓
build_snapshot_sync() → dashboard_snapshot (UPSERT)
    ↓
write_cron_status() → cron_run_status (INSERT)
```

### 2. Dispatch Pipeline (update)

```
recent_chapters (SELECT 24h)
    ↓
filter_whitelisted() → whitelist (JOIN)
    ↓
dispatch() → dispatch_history (INSERT)
    ↓
write_cron_status() → cron_run_status (INSERT)
```

### 3. FCFS Dedup

```
dispatch_history: UNIQUE (chapter_url) + UNIQUE (fcfs_key)
fcfs_key = normalize_title(title) + "#" + normalize_chapter(chapter)
```

### 4. RSS Feed Generation

```
recent_chapters (24h window)
    ↓
LEFT JOIN whitelist (cover, metadata) — 100% hit (no manga_metadata needed)
    ↓
FILTER excluded_titles (remove hidden)
    ↓
FILTER dispatch_history (mark isSent)
    ↓
ORDER BY created_at DESC
```

---

## Data Retention

| Table              | Retention | Current Rows | Growth/Day |
| ------------------ | --------- | ------------ | ---------- |
| cron_run_status    | 90 days   | 13,235       | ~200       |
| dispatch_history   | 90 days   | 922          | ~50        |
| recent_chapters    | 24 hours  | 329          | ~600       |
| dashboard_snapshot | Singleton | 1            | -          |
| whitelist          | Permanent | 343          | +1         |
| source_health      | Permanent | 2            | -          |
| guild_settings     | Permanent | 1            | -          |
| excluded_titles    | Permanent | 14           | -          |

---

## Migration History

| #   | File                                      | Description                                                                          |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| 011 | reconcile_live_schema.sql                 | Initial schema creation                                                              |
| 013 | dashboard_snapshot.sql                    | Add dashboard snapshot table                                                         |
| 017 | whitelist_type.sql                        | Add type column to whitelist                                                         |
| 018 | excluded_titles_unique.sql                | Add unique constraint                                                                |
| 025 | recent_chapters_composite_unique.sql      | Composite unique on chapter_url                                                      |
| 028 | fix_cron_run_status_status_text.sql       | Fix status column type                                                               |
| 032 | continue_reading.sql                      | Add continue_reading table                                                           |
| 033 | fix_cron_run_status_id.sql                | Fix NULL ids + add PK + index                                                        |
| 034 | fix_unique_null_merge_whitelist.sql       | Fix UNIQUE+NULL, merge whitelist_entries                                             |
| 035 | fix_architecture_20260829.sql             | 15→8 tables, fix all defects                                                         |
| 036 | add_genres_20260829.sql                   | genres jsonb + GIN index                                                             |
| 037 | add_status_rating_20260829.sql            | status + rating text columns                                                         |
| 038 | add_pk_whitelist_excluded_dh_20260830.sql | PK+id for whitelist/excluded_titles/dispatch_history, dh indexes, snapshot TTL index |
| 039 | add_metadata_enriched_at_20260830.sql     | series_meta enriched_at                                                              |
| 040 | add_trigram_search_20260830.sql           | GIN trigram for title search                                                         |
| 041 | migrate_rating_to_float_20260901.sql      | rating text → float                                                                  |
| 042 | add_origin_to_series_meta_20260901.sql    | origin column series_meta                                                            |
| 043 | continue_reading_gin.sql                  | GIN entries + updated_at index for analytics                                         |

---

## Backup & Recovery

```bash
# Full backup
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Table-specific
pg_dump $DATABASE_URL -t recent_chapters > recent_chapters.sql
pg_dump $DATABASE_URL -t whitelist > whitelist.sql

# Restore
psql $DATABASE_URL < backup.sql
```

---

**Generated by:** Muse Spark
**Audit Date:** 2026-09-03
**Database Version:** PostgreSQL 15+ (pooler psycopg2)
