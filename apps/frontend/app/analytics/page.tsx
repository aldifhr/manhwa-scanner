"use client";

import dynamic from "next/dynamic";
import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { getAnalyticsOverview, getAnalyticsEngagement, getAnalyticsRetention } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { AnalyticsOverview, AnalyticsEngagement } from "@/lib/types";

const Chart = dynamic(() => import("react-apexcharts"), { ssr: false });

const SOURCE_COLOR: Record<string, string> = {
  ikiru: "#10b981",
  shinigami: "#ef4444",
  voratoon: "#f97316",
};

const GENRE_COLORS = ["#10b981", "#3b82f6", "#f97316", "#8b5cf6", "#ec4899", "#eab308", "#06b6d4", "#f43f5e", "#6366f1", "#14b8a6"];

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-surface rounded-lg p-4 border border-border">
      <p className="text-xs text-text-muted uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub ? <p className="text-xs text-text-muted mt-1">{sub}</p> : null}
    </div>
  );
}

export default function AnalyticsPage() {
  const overviewQ = useQuery({
    queryKey: queryKeys.analyticsOverview,
    queryFn: getAnalyticsOverview,
    refetchInterval: 15_000,
  });
  const engagementQ = useQuery({
    queryKey: queryKeys.analyticsEngagement,
    queryFn: getAnalyticsEngagement,
    refetchInterval: 15_000,
  });
  const retentionQ = useQuery({
    queryKey: queryKeys.analyticsRetention,
    queryFn: getAnalyticsRetention,
    refetchInterval: 15_000,
  });

  const overview = overviewQ.data as AnalyticsOverview | null;
  const engagement = engagementQ.data as AnalyticsEngagement | null;
  const retention = (retentionQ.data as any) as import("@/lib/api").RetentionData | null;
  const overviewError = overviewQ.error as Error | null;
  const engagementError = engagementQ.error as Error | null;

  if (overviewQ.isLoading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
        </div>
      </PageShell>
    );
  }

  if (overviewError || !overview) {
    return (
      <PageShell>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="text-red-400 text-sm">Failed to load analytics overview — {overviewError instanceof Error ? overviewError.message : "unknown error"}</p>
          {engagementError ? <p className="text-red-400/70 text-xs mt-2">Engagement also failed: {engagementError.message}</p> : null}
        </div>
      </PageShell>
    );
  }

  const sourceDist = overview.source_distribution ?? [];
  const popular = overview.popular_series?.slice(0, 10) ?? [];
  const genres = overview.top_genres?.slice(0, 10) ?? [];
  const velocity = [...(overview.chapter_velocity ?? [])].reverse();

  const baseOpts = {
    chart: { background: "transparent", toolbar: { show: false }, fontFamily: "inherit" },
    grid: { borderColor: "rgba(255,255,255,0.06)" },
    tooltip: { theme: "dark" as const },
  };

  const donutOpts = {
    ...baseOpts,
    chart: { ...baseOpts.chart, type: "donut" as const },
    labels: sourceDist.map((s) => s.source),
    colors: sourceDist.map((s) => SOURCE_COLOR[s.source] ?? "#52525b"),
    legend: { position: "bottom" as const, labels: { colors: "#a1a1aa" } },
    dataLabels: { enabled: false },
    stroke: { show: false },
    plotOptions: { pie: { donut: { size: "62%" } } },
  };

  const popularOpts = {
    ...baseOpts,
    chart: { ...baseOpts.chart, type: "bar" as const },
    plotOptions: { bar: { horizontal: true, distributed: true, barHeight: "55%", borderRadius: 4 } },
    colors: popular.map((s) => SOURCE_COLOR[s.source] ?? "#71717a"),
    xaxis: { categories: popular.map((s) => (s as any).title ?? s.title_key), labels: { style: { colors: "#a1a1aa", fontSize: "11px" } }, axisTicks: { show: false } },
    yaxis: { labels: { style: { colors: "#a1a1aa", fontSize: "11px" }, maxWidth: 160 } },
    dataLabels: { enabled: false },
    legend: { show: false },
  };

  const genreOpts = {
    ...baseOpts,
    chart: { ...baseOpts.chart, type: "bar" as const },
    plotOptions: { bar: { horizontal: true, barHeight: "55%", borderRadius: 4 } },
    colors: ["#10b981"],
    xaxis: { categories: genres.map((g) => g.genre), labels: { style: { colors: "#a1a1aa", fontSize: "11px" } } },
    yaxis: { labels: { style: { colors: "#a1a1aa", fontSize: "11px" } } },
    dataLabels: { enabled: false },
  };

  const velocityOpts = {
    ...baseOpts,
    chart: { ...baseOpts.chart, type: "area" as const, sparkline: { enabled: false } },
    colors: ["#10b981"],
    stroke: { curve: "smooth" as const, width: 2 },
    fill: { type: "gradient" as const, gradient: { opacityFrom: 0.35, opacityTo: 0.02 } },
    xaxis: { categories: velocity.map((v) => v.date.slice(5)), labels: { style: { colors: "#71717a", fontSize: "11px" } }, axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: { style: { colors: "#71717a" } } },
    dataLabels: { enabled: false },
  };

  return (
    <PageShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">{overview.generated_at ? new Date(overview.generated_at).toLocaleString() : ""} · auto 15s</span>
          <button
            onClick={() => { overviewQ.refetch(); engagementQ.refetch(); retentionQ.refetch(); }}
            disabled={overviewQ.isFetching || engagementQ.isFetching || retentionQ.isFetching}
            className="px-2.5 py-1 rounded-md border border-border text-xs hover:bg-white/5 disabled:opacity-50"
          >
            {overviewQ.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Dispatches (7d)" value={overview.chapter_velocity?.reduce((a, b) => a + (b.total_dispatches ?? 0), 0) ?? 0} sub={`${overview.chapter_velocity?.length ?? 0} days`} />
        <StatCard label="Active readers (24h)" value={engagement?.active_sessions_24h ?? 0} sub="sessions" />
        <StatCard label="Failed (7d)" value={overview.failed_dispatch_stats?.still_failed ?? 0} sub={`${overview.failed_dispatch_stats?.total_failed ?? 0} total`} />
      </div>

      {/* Retention: dispatched vs read (continue_reading) */}
      <div className="bg-surface rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-1">Retention 30d — dispatched vs read</h2>
        <p className="text-xs text-text-muted mb-3">isWhitelisted dispatch (30d) vs continue_reading read sessions — title-based (handles shinigami UUID vs voratoon slug)</p>
        {retentionQ.isLoading ? (
          <p className="text-xs text-text-muted">Loading retention…</p>
        ) : retention ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Overall" value={`${retention.overall_retention_30d}%`} sub={`${retention.retained_titles}/${retention.total_whitelisted} retained`} />
              <StatCard label="Retained" value={retention.retained_titles} sub="titles read ≥1" />
              <StatCard label="Churned" value={retention.churned_titles} sub="dispatched but not read" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs font-semibold mb-2">Top retained</h3>
                {retention.top_retained?.length ? (
                  <div className="space-y-1.5">
                    {retention.top_retained.map((r) => (
                      <div key={r.title_key} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 truncate">{r.title}</span>
                        <span className="text-text-muted">{r.dispatched_30d} disp</span>
                        <span className="font-medium">{r.read_sessions} read</span>
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">{r.retention_pct}%</span>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-xs text-text-muted">No retained</p>}
              </div>
              <div>
                <h3 className="text-xs font-semibold mb-2">Top churned</h3>
                {retention.top_churned?.length ? (
                  <div className="space-y-1.5">
                    {retention.top_churned.map((r) => (
                      <div key={r.title_key} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 truncate">{r.title}</span>
                        <span className="text-text-muted">{r.dispatched_30d} disp</span>
                        <span className="font-medium text-red-400">{r.read_sessions} read</span>
                        <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">{r.retention_pct}%</span>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-xs text-text-muted">No churned</p>}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-muted">No retention data</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold mb-2">Source distribution (7d)</h2>
          {sourceDist.length ? (
            <Chart options={donutOpts as any} series={sourceDist.map((s) => s.count)} type="donut" height={260} />
          ) : (
            <p className="text-xs text-text-muted">No data</p>
          )}
          <div className="flex gap-4 justify-center mt-2">
            {sourceDist.map((s) => (
              <span key={s.source} className="flex items-center gap-1.5 text-xs">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: SOURCE_COLOR[s.source] ?? "#52525b" }} />
                <span className="capitalize text-text-muted">{s.source}</span>
                <span className="font-medium">{s.count}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="bg-surface rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold mb-2">Popular series (7d)</h2>
          {popular.length ? (
            <Chart
              options={popularOpts as any}
              series={[{ name: "dispatches", data: popular.map((s) => s.dispatch_count) }]}
              type="bar"
              height={300}
            />
          ) : (
            <p className="text-xs text-text-muted">No data</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold mb-2">Top genres</h2>
          {genres.length ? (
            <Chart options={genreOpts as any} series={[{ name: "count", data: genres.map((g) => g.count) }]} type="bar" height={300} />
          ) : (
            <p className="text-xs text-text-muted">No data</p>
          )}
        </div>

        <div className="bg-surface rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold mb-2">Chapter velocity (7d)</h2>
          {velocity.length ? (
            <Chart
              options={velocityOpts as any}
              series={[
                { name: "dispatches", data: velocity.map((v) => v.total_dispatches) },
                { name: "series", data: velocity.map((v) => v.unique_series) },
              ]}
              type="area"
              height={300}
            />
          ) : (
            <p className="text-xs text-text-muted">No data</p>
          )}
        </div>
      </div>


    </PageShell>
  );
}
