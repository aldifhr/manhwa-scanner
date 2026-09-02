// Centralized TanStack Query keys — single source of truth to avoid typos
// (e.g. invalidating "dashboard" but querying "dashboardSnapshot" would silently no-op).

export const queryKeys = {
  whitelist: ["whitelist"] as const,
  homeFeed: ["home-feed"] as const,
  rssFeedFlat: (
    exclude?: string,
    limit?: number,
    source?: string | null,
    whitelist = false,
    type?: string | null
  ) =>
    [
      "rss-feed-flat",
      exclude ?? "",
      limit ?? 1000,
      source ?? "all",
      whitelist,
      type ?? "all",
    ] as const,
  dispatchHistory: (search?: string) =>
    ["dispatch-history", search ?? ""] as const,
  dashboardSnapshot: ["dashboard-snapshot"] as const,
  queueDepth: ["queue-depth"] as const,
  excludedTitles: ["excluded-titles"] as const,
  stats: ["stats"] as const,
  rssHealth: ["rss-health"] as const,
  cronStatus: ["cron-status"] as const,
  analyticsOverview: ["analytics-overview"] as const,
  analyticsEngagement: ["analytics-engagement"] as const,
};

export const staleTimes = {
  dashboard: 60_000,
  rss: 60_000,
  whitelist: 60_000,
  dispatch: 300_000,
  excluded: 15_000,
  stats: 60_000,
  queue: 30_000,
  rssHealth: 30_000,
  cronStatus: 15_000,
} as const;
