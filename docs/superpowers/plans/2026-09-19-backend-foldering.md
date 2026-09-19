# Backend Foldering Reorg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rapikan `apps/backend/app/**` jadi domain-folder konsisten, hilangkan double-name flat.

**Architecture:** Domain-folder per concern: `api/` mirror `v1` endpoints per domain, `scrapers/` per-source folder, `cron/` per-job folder, `services/` vs `storage/` layered. Move files + update imports + `py_compile`.

**Tech Stack:** FastAPI, Pydantic, Supabase (sync), no new deps.

**Spec:** User request "foldering backend diatur dulu yang rapih SEMUA" + audit 55 endpoints → 26 core.

## Global Constraints

* Keep `CORE` + `ADMIN/CRON` endpoints alive: `/reader/*`, `/rss`, `/catalog/*`, `/whitelist`, `/dispatch-history`, `/excluded-titles`, `/dashboard-snapshot`, `/health/detailed`, `/sources/health`, `/cron/*`, `/auth`, `/metrics`
* `BE: py_compile` + `FE: tsc` must stay 0 after each task
* No placeholder steps

---

### Task 1: API `rss` → folder (done) — verify

**Files:**
- Modify: `apps/backend/app/api/rss/__init__.py` (exists)
- Modify: `apps/backend/app/api/rss/custom.py` (exists)
- Modify: `apps/backend/app/routers/content.py:2`
- Modify: `apps/backend/app/routers/core.py:2`

- [x] **Step 1: Verify moved**
```bash
py -m py_compile apps/backend/app/api/rss/__init__.py apps/backend/app/api/rss/custom.py
# BE:0
```

### Task 2: API `audit` → single file (done) — verify

**Files:**
- Modify: `apps/backend/app/api/audit.py` (exists)
- Modify: `apps/backend/app/routers/content.py:1-7`

- [x] **Verify**
```bash
py -m py_compile apps/backend/app/api/audit.py
```

### Task 3: API `cover` extract (done) — verify

**Files:**
- Modify: `apps/backend/app/api/cover.py`
- Modify: `apps/backend/app/api/observability.py:286` (remove proxy)
- Modify: `apps/backend/app/routers/core.py`

- [x] **Verify** `py -m py_compile apps/backend/app/api/cover.py`

### Task 4: API `cron` consolidate

**Files:**
- Create: `apps/backend/app/api/cron.py` (done, `cron_status+health`)
- Modify: `apps/backend/app/routers/core.py:2` (single import)
- Delete: `apps/backend/app/api/cron_status.py`, `cron_health.py` (done)

- [ ] **Step 1: Verify no stray import**
```bash
powershell -Command "Select-String -Path 'apps/backend/app/**/*.py' -Pattern 'cron_status|cron_health' | Select-Object -First 5"
# expect 0
```

- [ ] **Step 2: Commit**
```bash
git add apps/backend/app/api/cron.py apps/backend/app/routers/core.py
git commit -m "refactor: consolidate cron_health+status → cron.py"
```

### Task 5: Scrapers per-source folder (done 3)

**Files:**
- Modify: `apps/backend/app/scrapers/ikiru/__init__.py`
- Modify: `apps/backend/app/scrapers/shinigami/__init__.py` + `models.py`
- Modify: `apps/backend/app/scrapers/voratoon/__init__.py`

- [x] **Verify** `py -m py_compile apps/backend/app/scrapers/*/`

### Task 6: Dashboard API → admin folder

**Files:**
- Create: `apps/backend/app/api/admin/` dir
- Move: `apps/backend/app/api/dashboard/catalog.py` → `api/admin/catalog.py`
- Move: `apps/backend/app/api/dashboard/whitelist.py` → `api/admin/whitelist.py`
- Move: `apps/backend/app/api/dashboard/stats.py` → `api/admin/stats.py`
- Move: `apps/backend/app/api/dashboard/excluded_titles.py` → `api/admin/excluded.py`
- Modify: `apps/backend/app/routers/core.py` + `content.py` imports `dashboard` → `admin`

- [ ] **Step 1: Move files**
```bash
New-Item -ItemType Directory -Path apps/backend/app/api/admin -Force
Move-Item api/dashboard/*.py api/admin/
```

- [ ] **Step 2: Update imports**
```python
from app.api.admin import catalog as catalog_api # was dashboard.catalog
```

- [ ] **Step 3: Verify**
```bash
py -m py_compile apps/backend/app/api/admin/*.py
```

- [ ] **Step 4: Commit**
```bash
git add apps/backend/app/api/admin apps/backend/app/routers
git commit -m "refactor: dashboard → admin folder"
```

### Task 7: Observability god-file split — history/incidents

**Files:**
- Create: `apps/backend/app/api/history.py` (extract `GET /history` from `observability.py:114`)
- Create: `apps/backend/app/api/incidents.py` (extract `GET /incidents` from `observability.py:163`)
- Modify: `apps/backend/app/api/observability.py` keep only `health-status` + `internal/metrics` → rename `apps/backend/app/api/health_status.py` or keep
- Modify: `apps/backend/app/routers/core.py` register `history_api`, `incidents_api`

- [ ] **Step 1: Write history.py**
```python
from fastapi import APIRouter
router = APIRouter()
@router.get("/history") ...
```

- [ ] **Step 2: Write incidents.py** similarly

- [ ] **Step 3: Trim observability.py**

- [ ] **Step 4: Verify** `py -m py_compile`

- [ ] **Step 5: Commit**

### Task 8: Enrich cron folder

**Files:**
- Create: `apps/backend/app/cron/enrich/` dir
- Move: `apps/backend/app/cron/enrich.py` → `cron/enrich/__init__.py`
- Move: `apps/backend/app/cron/enrich_resync.py` → `cron/enrich/resync.py`
- Move: `apps/backend/app/cron/enrich_whitelist.py` → `cron/enrich/whitelist.py`
- Modify: imports `from app.cron.enrich` → `from app.cron.enrich.whitelist`

- [ ] **Step 1: Move + update imports**
- [ ] **Step 2: Verify**
- [ ] **Step 3: Commit**

### Task 9: Storage dedup — `recent_chapters_sql` vs `recent_chapters`

**Files:**
- Modify: `apps/backend/app/storage/recent_chapters.py` vs `recent_chapters_sql.py` — one uses `q()` raw SQL, one uses `supabase` builder. Keep `recent_chapters.py` (builder) + inline SQL helpers, delete `recent_chapters_sql.py`.

- [ ] **Step 1: Grep callers**
```bash
Select-String -Path apps/backend/app/**/*.py -Pattern recent_chapters_sql
```

- [ ] **Step 2: Merge + delete**

### Task 10: Final verification

**Files:**
- All `apps/backend/app/**/*.py`

- [ ] **Step 1: Full compile**
```bash
py -m compileall apps/backend/app
```

- [ ] **Step 2: FE tsc**

```bash
.\apps\frontend\node_modules\.bin\tsc --noEmit --project apps/frontend/tsconfig.json
```

- [ ] **Step 3: OpenAPI regen**

```bash
py -c "from app.main import app; import json; open('apps/backend/openapi.json','w').write(json.dumps(app.openapi()))"
```
