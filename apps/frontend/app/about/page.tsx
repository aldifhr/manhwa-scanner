import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";

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

export default async function AboutPage() {
  const stats = await getStats();

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

      {/* Source status */}
      {stats && (
        <section className="bg-surface border border-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-text mb-3">Sources</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.sources).map(([name, status]) => (
              <span
                key={name}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${
                  status === "healthy"
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                    : "bg-amber-500/10 border-amber-500/30 text-amber-400"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    status === "healthy" ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
                {name}: {status}
              </span>
            ))}
          </div>
          {stats.by_origin &&
            (() => {
              const entries = Object.entries(stats.by_origin) as [
                string,
                number,
              ][];
              const total = entries.reduce((a, [, c]) => a + c, 0) || 1;
              const COLORS: Record<string, string> = {
                korean: "bg-accent",
                korean_manhwa: "bg-accent",
                manhwa: "bg-accent",
                chinese: "bg-emerald-500",
                manhua: "bg-emerald-500",
                japanese: "bg-violet-500",
                manga: "bg-violet-500",
              };
              return (
                <div className="mt-4 space-y-3">
                  <div className="flex h-2 rounded-full overflow-hidden bg-surface-hover">
                    {entries.map(([origin, count]) => (
                      <div
                        key={origin}
                        className={`${COLORS[origin.toLowerCase()] ?? "bg-white/20"} transition-all`}
                        style={{ width: `${(count / total) * 100}%` }}
                        title={`${origin}: ${count}`}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs">
                    {entries.map(([origin, count]) => (
                      <span
                        key={origin}
                        className="inline-flex items-center gap-1.5 text-text-muted"
                      >
                        <span
                          className={`w-2 h-2 rounded-full ${COLORS[origin.toLowerCase()] ?? "bg-white/20"}`}
                        />
                        <strong className="text-text tabular-nums">
                          {count}
                        </strong>{" "}
                        {origin}
                        <span className="text-text-muted">
                          ({Math.round((count / total) * 100)}%)
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
        </section>
      )}

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
