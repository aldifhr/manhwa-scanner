# AGENTS.md — manhwa-scanner (superpowers: all 14 active)

Pakai obra/superpowers untuk semua flow. Hermes auto-load via `using-superpowers`.

## Skills aktif (14)
- brainstorming → sebelum fitur baru (scraper source, enrich, whisper)
- writing-plans → plan di `.agents/plans/` sebelum ponytail sweep
- executing-plans / dispatching-parallel-agents / subagent-driven-development → eksekusi paralel collect/enrich/dispatch
- test-driven-development → guard `pipeline shim` + `health 900s` + `whitelist`
- systematic-debugging → `InterfaceError pool closed`, `NameError`, `2112 error_logs`
- verification-before-completion → `py_compile + pytest + pm2 logs + curl rss` tiap push
- using-git-worktrees → isolasi ponytail branch
- finishing-a-development-branch / requesting/receiving-code-review / writing-skills → close loop

## Ponytail
level: full (ladder enforced). `ponytail:` comment + trigger tiap simplifikasi.

## Verify
`npx skills list` → 14 OK. Hermes `skill_view(name='writing-plans')` ready.
