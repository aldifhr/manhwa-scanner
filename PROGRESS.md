# PROGRESS.md — Catatan Perubahan Code

> Format: `YYYY-MM-DD | Commit | Ringkasan` — sumber `git log --oneline`.

## 2026-09-02 — Initial Monorepo

| Tanggal | Commit | Perubahan |
|---|---|---|
| 2026-09-02 | `44dcfe8` | init — monorepo 1 repo 1 codebase (`apps/frontend` Next.js + `apps/backend` FastAPI), pnpm workspace, clean history tanpa `.next` |

> Commit saat ini cuma `init` (orphan clean). Untuk log lengkap: `git log --oneline`.

## Catatan Dev

- `pnpm run dev` → `pnpm --filter manhwa-reader dev` (`apps/frontend` `next dev` tanpa `next build`), `pnpm approve-builds --all` sekali setelah install.
- `.env` dipisah: `apps/frontend/.env.local`, `apps/backend/.env`.
- `pnpm-lock.yaml` tunggal di root.
