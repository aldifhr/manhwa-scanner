import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { Reader } from "@/lib/reader";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About · ManhwaScanner",
  description:
    "What powers this dashboard — a self-hosted manga release tracker.",
};

interface PublicStats {
  series_tracked: number;
  series_unique: number;
  chapters_indexed: number;
  notifications_sent: number;
  sent_last_24h: number;
  chapters_last_24h: number;
  avg_chapters_per_day_7d: number;
  sources: Record<string, string>;
  sources_active: number;
  by_origin: Record<string, number>;
}

interface SourceHealth {
  name: string;
  source: string;
  status: string;
  lastCheck: string;
  lastSuccess: string;
  uptimePct: number;
  successRate24h: number;
  avgResponseTimeMs: number;
  consecutiveFailures: number;
  lastError: string | null;
  disabledUntil: string | null;
  successesToday: number;
  failuresToday: number;
}

interface HeatmapDay {
  date: string;
  count: number;
}

interface ActivityHeatmap {
  weeks: number;
  days: HeatmapDay[];
  total: number;
  peak: { date: string; count: number } | null;
}

interface RetentionItem {
  title_key: string;
  title: string;
  dispatched_30d: number;
  read_sessions: number;
  retention_pct: number;
}

interface AnalyticsRetention {
  overall_retention_30d: number;
  total_whitelisted: number;
  retained_titles: number;
  churned_titles: number;
  top_retained: RetentionItem[];
  top_churned: RetentionItem[];
}

async function getStats(): Promise<PublicStats | null> {
  try {
    const res = await fetch(
      `${process.env.BACKEND_URL || "https://scanner.aldifhr.fun"}/api/public/stats`,
      {
        next: { revalidate: 60 },
      }
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function getSourcesHealth(): Promise<SourceHealth[] | null> {
  try {
    const data = await Reader.getSourcesHealth();
    return Array.isArray(data) ? (data as unknown as SourceHealth[]) : null;
  } catch {
    return null;
  }
}

async function getActivityHeatmap(): Promise<ActivityHeatmap | null> {
  try {
    const data = await Reader.getActivityHeatmap();
    return data as unknown as ActivityHeatmap;
  } catch {
    return null;
  }
}

async function getAnalyticsRetention(): Promise<AnalyticsRetention | null> {
  try {
    const data = await Reader.getAnalyticsRetention();
    return data as unknown as AnalyticsRetention;
  } catch {
    return null;
  }
}

const FEATURES = [
  [
    "Multi-source scraping",
    "Aggregates releases from multiple manga sources with health probes and automatic degradation handling.",
  ],
  [
    "Real-time notifications",
    "Chapter alerts fan out to every registered server, each with its own origin filter (KR/CN/JP) and exclusion list.",
  ],
  [
    "Exactly-once delivery",
    "FCFS claim system keyed on normalized title+chapter — a re-scraped chapter never double-notifies.",
  ],
  [
    "Resilience engineering",
    "Circuit breakers per source, jittered exponential backoff, retry queues for transient failures.",
  ],
  [
    "Chapter gap detection",
    "Compares what was scraped vs. what was actually notified; flags missing chapters automatically.",
  ],
  [
    "Fuzzy slug aliasing",
    "Cross-source title variants (dash/space/typo differences) merge into one canonical entry.",
  ],
];

function statusColor(status: string): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-400";
    case "degraded":
      return "bg-amber-400";
    default:
      return "bg-red-400";
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500/10 border-emerald-500/30 text-emerald-400";
    case "degraded":
      return "bg-amber-500/10 border-amber-500/30 text-amber-400";
    default:
      return "bg-red-500/10 border-red-500/30 text-red-400";
  }
}

export default async function AboutPage() {
  const [stats, sourcesHealth, heatmap, retention] = await Promise.all([
    getStats(),
    getSourcesHealth(),
    getActivityHeatmap(),
    getAnalyticsRetention(),
  ]);

  return (
    <PageShell variant="narrow">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text">
          Manhwa<span className="text-accent">Scanner</span>
        </h1>
        <p className="text-text-muted mt-2 text-sm leading-relaxed">
          A self-hosted manga release tracker: scrapes multiple sources on a
          cron cycle, matches them against a curated whitelist, and pushes
          real-time chapter updates — with this Next.js dashboard for monitoring
          and control.
        </p>
      </div>

      {/* Live numbers */}
      <section
        className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        aria-busy={stats ? "false" : "true"}
        aria-live="polite"
      >
        {[
          { label: "Series tracked", value: stats?.series_unique },
          { label: "Notifications sent", value: stats?.notifications_sent },
          { label: "Sent last 24h", value: stats?.sent_last_24h },
          { label: "Avg / day (7d)", value: stats?.avg_chapters_per_day_7d },
        ].map((s) => (
          <div
            key={s.label}
            className="bg-surface border border-border rounded-xl p-4 text-center min-h-21 flex flex-col justify-center"
          >
            {s.value != null ? (
              <div className="text-2xl font-bold text-accent tabular-nums">
                {Number(s.value).toLocaleString()}
              </div>
            ) : (
              <div className="skeleton h-7 w-16 rounded mx-auto" aria-hidden />
            )}
            <div className="text-[11px] text-text-muted mt-1">{s.label}</div>
          </div>
        ))}
      </section>

      {/* Sources Health */}
      <section className="bg-surface border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-text mb-3">Sources Health</h2>
        {sourcesHealth ? (
          <div className="space-y-2">
            {sourcesHealth.map((src) => (
              <div
                key={src.name}
                className="flex items-center justify-between py-2 border-b border-border last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${statusColor(src.status)}`}
                  />
                  <span className="text-sm text-text">{src.name}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span className="tabular-nums">{src.uptimePct}%</span>
                  <span className="tabular-nums">{src.avgResponseTimeMs}ms</span>
                  {src.consecutiveFailures > 0 && (
                    <span className="text-amber-400 tabular-nums">
                      {src.consecutiveFailures} fail
                    </span>
                  )}
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusBadge(src.status)}`}
                  >
                    {src.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2" aria-hidden>
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-8 w-full rounded" />
            ))}
          </div>
        )}
      </section>

      {/* Activity Heatmap */}
      <section className="bg-surface border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-text mb-3">
          Activity Heatmap
        </h2>
        {heatmap ? (
          <>
            <div className="flex gap-1 flex-wrap">
              {heatmap.days.map((day) => {
                const intensity = heatmap.peak?.count
                  ? day.count / heatmap.peak.count
                  : 0;
                return (
                  <div
                    key={day.date}
                    className="w-3 h-3 rounded-sm"
                    style={{
                      backgroundColor:
                        day.count > 0
                          ? `rgba(245, 158, 11, ${0.15 + intensity * 0.85})`
                          : "rgba(255,255,255,0.04)",
                    }}
                    title={`${day.date}: ${day.count} chapters`}
                  />
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-text-muted">
              <span>{heatmap.total} chapters scanned</span>
              {heatmap.peak && (
                <span>
                  Peak: {heatmap.peak.count} on {heatmap.peak.date}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="skeleton h-20 w-full rounded" aria-hidden />
        )}
      </section>

      {/* Analytics Retention */}
      <section className="bg-surface border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-text mb-3">
          Analytics Retention
        </h2>
        {retention ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {[
                {
                  label: "30d retention",
                  value: `${retention.overall_retention_30d}%`,
                  color: "text-accent",
                },
                {
                  label: "Whitelisted",
                  value: retention.total_whitelisted,
                  color: "text-accent",
                },
                {
                  label: "Retained",
                  value: retention.retained_titles,
                  color: "text-emerald-400",
                },
                {
                  label: "Churned",
                  value: retention.churned_titles,
                  color: "text-red-400",
                },
              ].map((item) => (
                <div key={item.label} className="text-center">
                  <div
                    className={`text-xl font-bold tabular-nums ${item.color}`}
                  >
                    {item.value}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    {item.label}
                  </div>
                </div>
              ))}
            </div>

            {retention.top_retained.length > 0 && (
              <div className="mb-3">
                <h3 className="text-xs font-medium text-text-muted mb-2">
                  Top Retained
                </h3>
                <div className="space-y-1">
                  {retention.top_retained.slice(0, 5).map((item) => (
                    <div
                      key={item.title_key}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-text truncate mr-2">
                        {item.title}
                      </span>
                      <span className="text-emerald-400 tabular-nums">
                        {item.retention_pct}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {retention.top_churned.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-text-muted mb-2">
                  Top Churned
                </h3>
                <div className="space-y-1">
                  {retention.top_churned.slice(0, 5).map((item) => (
                    <div
                      key={item.title_key}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-text truncate mr-2">
                        {item.title}
                      </span>
                      <span className="text-red-400 tabular-nums">
                        {item.retention_pct}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="skeleton h-24 w-full rounded" aria-hidden />
        )}
      </section>

      {/* Feature highlights */}
      <section>
        <h2 className="text-sm font-semibold text-text mb-3">How it works</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {FEATURES.map(([title, desc]) => (
            <div
              key={title}
              className="bg-surface border border-border rounded-xl p-4"
            >
              <div className="text-sm font-medium text-text mb-1">{title}</div>
              <div className="text-xs text-text-muted leading-relaxed">
                {desc}
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="text-center text-text-muted text-xs">
        Live data · refreshed every minute
      </p>
    </PageShell>
  );
}
