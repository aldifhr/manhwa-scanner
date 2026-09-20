# AGENTS.md — manhwa-scanner (superpowers: all 14 active)

Pakai obra/superpowers untuk semua flow. Hermes auto-load via `using-superpowers`.

## Skills aktif (14)
- brainstorming → sebelum fitur baru (scraper source, enrich, whisper)
- writing-plans → plan di `.agents/plans/` sebelum implementasi
- executing-plans / dispatching-parallel-agents / subagent-driven-development → eksekusi paralel collect/enrich/dispatch
- test-driven-development → guard `pipeline shim` + `health 900s` + `whitelist`
- systematic-debugging → `InterfaceError pool closed`, `NameError`, `2112 error_logs`
- verification-before-completion → `py_compile + pytest + pm2 logs + curl rss` tiap push
- using-git-worktrees → isolasi branch
- finishing-a-development-branch / requesting/receiving-code-review / writing-skills → close loop

## Cache (2026-09-20)
- BE: `common.py` Redis `series_meta:{source}:{sid}` 6h + in-memory `300s/6h` cross-worker
- FE: `lib/cache` `rss 30s+30s` `whitelist 30s+10s` `dashboard 60s` + `queryKeys staleTimes 30s` + `useInfiniteFeed refetchOnWindowFocus false`
- Scraper: `shinigami` bulk 3→full `get_shinigami_chapters` jika oldest <24h, `voratoon` dedup+filter 24h `13089→138`

## Verify
`npx skills list` → 14 OK. Hermes `skill_view(name='writing-plans')` ready.
