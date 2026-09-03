"use client";

import dynamic from "next/dynamic";
import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { getAnalyticsOverview, getAnalyticsEngagement } from "@/lib/api";
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
    refetchInterval: 60_000,
  });
  const engagementQ = useQuery({
    queryKey: queryKeys.analyticsEngagement,
    queryFn: getAnalyticsEngagement,
    refetchInterval: 60_000,
  });

  const overview = overviewQ.data as AnalyticsOverview | null;
  const engagement = engagementQ.data as AnalyticsEngagement | null;
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
  const growth = [...(overview.whitelist_growth ?? [])].reverse().slice(-30);
  const mostRead = engagement?.most_read_series?.slice(0, 8) ?? [];

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

  const growthOpts = {
    ...baseOpts,
    chart: { ...baseOpts.chart, type: "bar" as const },
    plotOptions: { bar: { columnWidth: "55%", borderRadius: 3 } },
    colors: ["#52525b"],
    xaxis: { categories: growth.map((g) => g.date.slice(5)), labels: { show: false }, axisTicks: { show: false }, axisBorder: { show: false } },
    yaxis: { labels: { style: { colors: "#71717a" } } },
    dataLabels: { enabled: false },
    grid: { show: false },
  };

  return (
    <PageShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <span className="text-xs text-text-muted">{overview.generated_at ? new Date(overview.generated_at).toLocaleString() : ""}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Dispatches (7d)" value={overview.chapter_velocity?.reduce((a, b) => a + (b.total_dispatches ?? 0), 0) ?? 0} sub={`${overview.chapter_velocity?.length ?? 0} days`} />
        <StatCard label="Whitelist growth (30d)" value={overview.whitelist_growth?.reduce((a, b) => a + (b.new_entries ?? 0), 0) ?? 0} sub="new series" />
        <StatCard label="Active readers (24h)" value={engagement?.active_sessions_24h ?? 0} sub="sessions" />
        <StatCard label="Failed (7d)" value={overview.failed_dispatch_stats?.still_failed ?? 0} sub={`${overview.failed_dispatch_stats?.total_failed ?? 0} total`} />
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold mb-2">Whitelist growth (30d)</h2>
          {growth.length ? (
            <Chart options={growthOpts as any} series={[{ name: "new", data: growth.map((g) => g.new_entries) }]} type="bar" height={200} />
          ) : (
            <p className="text-xs text-text-muted">No data</p>
          )}
        </div>

        <div className="bg-surface rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold mb-2">Most read (continue-reading)</h2>
          {engagementError ? (
            <p className="text-xs text-amber-400">Engagement unavailable: {engagementError.message.slice(0, 120)}</p>
          ) : mostRead.length ? (
            <Chart
              options={
                {
                  ...baseOpts,
                  chart: { ...baseOpts.chart, type: "bar" as const },
                  plotOptions: { bar: { horizontal: true, barHeight: "55%", borderRadius: 4 } },
                  colors: GENRE_COLORS,
                  xaxis: { categories: mostRead.map((r) => (r.title_key ?? "").slice(0, 18)), labels: { style: { colors: "#a1a1aa", fontSize: "11px" } } },
                  yaxis: { labels: { style: { colors: "#a1a1aa", fontSize: "11px" } } },
                  dataLabels: { enabled: false },
                } as any
              }
              series={[{ name: "readers", data: mostRead.map((r) => r.reader_count) }]}
              type="bar"
              height={280}
            />
          ) : (
            <p className="text-xs text-text-muted">No reading data yet</p>
          )}
        </div>
      </div>
    </PageShell>
  );
}
