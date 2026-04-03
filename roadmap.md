# Ikiru Bot Roadmap

This roadmap outlines the past achievements and future functional/logical improvements for the Ikiru Bot ecosystem.

## 🟢 Phase 1: Core Systems & Scraper Optimization *(COMPLETED)*
- [x] Fix **Shinigami 403** (Forbidden) errors with appropriate headers.
- [x] Refine **Title Matching Logic** to reduce cross-source ambiguity.
- [x] Stabilize the `/add` command for direct URL additions.
- [x] **Concurrency Refactor**: Optimized scraping engine with `p-limit` for high-volume execution without server hang.
- [x] **Content Filtering**: Restrict `/random` gacha only to Manhwa/Manhua content.

## 🟢 Phase 2: Monitoring, Logs, & Dashboard UI *(COMPLETED)*
- [x] **Dashboard Telemetry**: Dynamic Source Charts, Status Markers (Hiatus, End), and UI Badges.
- [x] **Logging Reliability**: Fix Dashboard Activity Logs to correctly display "sent" payloads and trends in real-time.
- [x] **Cross-Source Deduplication**: "Fastest source wins" matching to avoid duplicate spam on identical titles.
- [x] **MyProgress UI**: Implement paginated personal reading progress (`/myprogress`) directly in Discord.
- [x] **Deeper Health Checks**: Active scanning for dead links (404/Stale errors).

## 🟡 Phase 3: Bot Maintenance & Automation *(IN PROGRESS)*
- [x] **Automated Cleanup Recommendations**: Dashboard UI alerts for consistently broken links (Fail Streaks) with quick-delete options.
- [x] **Stale Manga Notifications**: Scheduled Discord alerts natively reporting unresponsive/dead links.
- [ ] **Smart Cache Invalidation**: Optimize Redis pipeline usage to lower overhead during traffic spikes.

## 🟠 Phase 4: System Scaling & Future Features *(UPCOMING PROPOSALS)*
- [ ] **Auto-Mirror Fallback**: If a primary source goes offline/403, have the scraper silently fall back to an active mirror source automatically.
- [ ] **Fatal Error Alerts**: Push instant diagnostic messages specifically to a designated Discord admin channel if the bot crashes or detects massive failure streaks.
- [ ] **Smart Rate Limiting Queue**: Implement advanced backoff and queue system for Discord API (429) to handle sudden spikes in new manga releases.

## 🟣 Phase 5: Community & Interactivity *(IDEATION)*
- [ ] **User-Level Preferences**: Slash commands to allow individual users to mute specific manga or customize update pings.


---
*Last Updated: 2026-04-03*
