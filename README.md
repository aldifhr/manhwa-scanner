# manhwa-scanner — Monorepo (1 repo 1 codebase)

Next.js Frontend + Python FastAPI Backend — single repo, synced via `openapi.json`.

- **Repo**: https://github.com/aldifhr/manhwa-scanner
- **Frontend**: `apps/frontend` — Next.js 15 App Router (TS)
- **Backend**: `apps/backend` — Python FastAPI (scraper shinigami/ikiru/voratoon)

## Monorepo Structure

```
apps/frontend/   # Next.js, pnm run dev (next dev tanpa build)
  app/           # Home, Recent, Whitelist, Exclude-list, Health, Bookmarks, Feed
  components/    # UI: MangaCard, PageShell, Nav, NavbarStatus
  lib/           # Reader seam, api, server-api, queryKeys
apps/backend/    # FastAPI, uv run uvicorn app.main:app --reload
packages/shared/ # (rencana) openapi.json → zod + TS types
```

## Development (tanpa build)

```bash
# root — FE only (BE belum ada package.json)
pnpm run dev              # → apps/frontend next dev (http://localhost:3000)
# atau langsung FE
cd apps/frontend && npm run dev

# BE
cd apps/backend && uv run uvicorn app.main:app --reload  # http://localhost:8000

# setup awal
pnpm install
pnpm approve-builds --all   # sekali untuk tree-sitter
```

## Production

```bash
cd apps/frontend && npm run build && npm run start
cd apps/backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Quality & Tests

```bash
pnpm --filter manhwa-reader typecheck
pnpm --filter manhwa-reader lint
pnpm --filter manhwa-reader test
```

## Environment

| Variable | Lokasi | Contoh |
|----------|--------|--------|
| `NEXT_PUBLIC_API_BASE` | `apps/frontend/.env.local` | `https://scanner.aldifhr.fun` |
| `BACKEND_URL` | `apps/frontend/.env.local` atau `apps/backend/.env` | `http://localhost:8000` |
| `API_TOKEN` | `apps/backend/.env` | `Bearer <token>` |
| `DATABASE_URL` | `apps/backend/.env` | Supabase |

> `.env` dipisah per app ( `apps/frontend/.env.local`, `apps/backend/.env` ), `pnpm-lock.yaml` tunggal di root.

## Docs

- `CONTEXT.md` — glossary domain & deep modules
- `PROGRESS.md` — log perubahan per tanggal/commit
- `apps/backend/openapi.json` — contract FE↔BE
