# Ikiru Bot Roadmap

This roadmap outlines the past achievements and future functional/logical improvements for the Ikiru Bot ecosystem.

## 🟢 Phase 1: Stability & Scraper Optimization (COMPLETED)
- [x] Fix **Shinigami 403** (Forbidden) errors by adding appropriate browser-like headers.
- [x] Refine **Title Matching Logic** to reduce ambiguity between different manga sources.
- [x] Stabilize the `/add` command for direct URL additions.

## 🟡 Phase 2: Dashboard Restoration & Monitoring (NEAR COMPLETION)
- [x] Fix critical **ReferenceErrors** that broke the dashboard whitelist.
- [x] Implement **Dynamic Source Charts** to automatically handle all active scrapers.
- [x] Add **Status Markers** (Hiatus, End, Season End) and **Source Badges** in the UI.
- [ ] Implement deeper health check status reporting for better troubleshooting.

## 🟠 Phase 3: Performance & Scalability (NEXT STEPS)
- [ ] **Concurrency Refactor**: Optimize the scraping engine to handle larger whitelists more efficiently.
- [ ] **Redis Optimization**: Review and optimize Redis usage for high-frequency updates.
- [ ] **Improved Logging**: Implement a more structured logging system for easier debugging of scraper failures.

## 🔴 Phase 4: Advanced Features & Ecosystem
- [ ] **Multi-Guild Support**: Better handling of channel mappings across multiple Discord servers.
- [ ] **Automated Cleanup**: Dashboard tool to suggest removing consistently broken or 404 links.
- [ ] **Export/Import**: Allow backing up and restoring whitelist data directly from the dashboard.
- [ ] **Localization**: Further refining localization across all bot commands and dashboard UI.

---
*Last Updated: 2026-04-01*
