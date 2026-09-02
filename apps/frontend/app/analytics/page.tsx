"use client";

import { useQuery } from "@tanstack/react-query";
import { getAnalyticsOverview, getAnalyticsEngagement } from "@/lib/api";
import { PageShell } from "@/components/PageShell";
import StatCard from "@/components/ui/StatCard";
import { Books, ChartLineUp, Star, Users } from "@phosphor-icons/react";

function BarRow({
  label,
  count,
  pct,
  tone = "accent",
}: {
  label: string;
  count: number;
  pct: number;
  tone?: "accent" | "success" | "danger" | "muted";
}) {
  const toneBg =
    tone === "success"
      ? "bg-success"
      : tone === "danger"
        ? "bg-danger"
        : tone === "muted"
          ? "bg-text-muted"
          : "bg-accent";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary capitalize">{label}</span>
        <span className="text-text-muted tabular-nums">
          {count} · {pct}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-surface-hover overflow-hidden">
        <div
          className={`h-full ${toneBg} transition-all duration-500`}
          style={{ width: `${Math.min(100, pct)}` }}
        />
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: overview, isLoading: loadingOverview } = useQuery({
    queryKey: ["analytics-overview"],
    queryFn: getAnalyticsOverview,
    staleTime: 60_000,
  });

  const { data: engagement, isLoading: loadingEngagement } = useQuery({
    queryKey: ["analytics-engagement"],
    queryFn: getAnalyticsEngagement,
    staleTime: 60_000,
  });

  const isLoading = loadingOverview || loadingEngagement;

  if (isLoading) {
    return (
      <PageShell>
        <div className="skeleton h-7 w-40 rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
        <div className="skeleton h-64 rounded-xl" />
      </PageShell>
    );
  }

  const popularSeries = overview?.popular_series || [];
  const velocity = overview?.chapter_velocity || [];
  const sourceDist = overview?.source_distribution || [];
  const topGenres = overview?.top_genres || [];
  const failedStats = overview?.failed_dispatch_stats as
    | {
        total_failed?: number;
        still_failed?: number;
        resolved?: number;
        permanent?: number;
      }
    | undefined;
  const activeSessions = engagement?.active_sessions_24h || 0;
  const totalSessions = engagement?.total_reading_sessions || 0;
  const mostRead = engagement?.most_read_series || [];

  const totalDispatches = velocity.reduce(
    (sum: number, v: { total_dispatches: number }) => sum + v.total_dispatches,
    0
  );
  const totalSeries = new Set(
    popularSeries.map((s: { title_key: string }) => s.title_key)
  ).size;

  return (
    <PageShell>
      <h1 className="text-xl font-semibold tracking-tight text-text">
        Analytics
      </h1>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          iconComponent={Books}
          label="Total Dispatches (7d)"
          value={totalDispatches}
          sub="notifications sent"
        />
        <StatCard
          iconComponent={ChartLineUp}
          label="Active Series"
          value={totalSeries}
          sub="with dispatches"
        />
        <StatCard
          iconComponent={Users}
          label="Active Users (24h)"
          value={activeSessions}
          sub="reading sessions"
        />
        <StatCard
          iconComponent={Star}
          label="Total Sessions"
          value={totalSessions}
          sub="registered"
        />
      </div>

      {/* Popular Series */}
      {popularSeries.length > 0 && (
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">
            Popular Series (7d)
          </h2>
          <div className="space-y-2">
            {popularSeries
              .slice(0, 10)
              .map(
                (s: {
                  title_key: string;
                  source: string;
                  dispatch_count: number;
                }) => (
                  <div
                    key={`${s.title_key}-${s.source}`}
                    className="flex items-center gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text truncate">
                        {s.title_key}
                      </div>
                      <div className="text-xs text-text-muted">{s.source}</div>
                    </div>
                    <span className="text-xs font-semibold text-accent tabular-nums shrink-0">
                      {s.dispatch_count} sends
                    </span>
                  </div>
                )
              )}
          </div>
        </section>
      )}

      {/* Source Distribution */}
      {sourceDist.length > 0 && (
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">
            Source Distribution (7d)
          </h2>
          {sourceDist.map((s: { source: string; count: number }) => {
            const total = sourceDist.reduce(
              (sum: number, x: { count: number }) => sum + x.count,
              0
            );
            const pct = total > 0 ? Math.round((s.count / total) * 100) : 0;
            return (
              <BarRow
                key={s.source}
                label={s.source}
                count={s.count}
                pct={pct}
              />
            );
          })}
        </section>
      )}

      {/* Top Genres */}
      {topGenres.length > 0 && (
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">Top Genres</h2>
          {topGenres.slice(0, 10).map((g: { genre: string; count: number }) => {
            const max = Math.max(
              ...topGenres.map((x: { count: number }) => x.count)
            );
            const pct = max > 0 ? Math.round((g.count / max) * 100) : 0;
            return (
              <BarRow
                key={g.genre}
                label={g.genre}
                count={g.count}
                pct={pct}
                tone="muted"
              />
            );
          })}
        </section>
      )}

      {/* Failed Dispatch Stats */}
      <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
        <h2 className="text-sm font-semibold text-text">
          Failed Dispatches (7d)
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg bg-surface-hover p-3">
            <div className="text-xs text-text-muted">Total Failed</div>
            <div className="text-lg font-semibold text-text">
              {failedStats?.total_failed || 0}
            </div>
          </div>
          <div className="rounded-lg bg-surface-hover p-3">
            <div className="text-xs text-text-muted">Still Failed</div>
            <div className="text-lg font-semibold text-danger">
              {failedStats?.still_failed || 0}
            </div>
          </div>
          <div className="rounded-lg bg-surface-hover p-3">
            <div className="text-xs text-text-muted">Resolved</div>
            <div className="text-lg font-semibold text-success">
              {failedStats?.resolved || 0}
            </div>
          </div>
          <div className="rounded-lg bg-surface-hover p-3">
            <div className="text-xs text-text-muted">Permanent</div>
            <div className="text-lg font-semibold text-text-muted">
              {failedStats?.permanent || 0}
            </div>
          </div>
        </div>
      </section>

      {/* Most Read Series */}
      {mostRead.length > 0 && (
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">Most Read Series</h2>
          <div className="space-y-2">
            {mostRead
              .slice(0, 10)
              .map((s: { title_key: string; reader_count: number }) => (
                <div key={s.title_key} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text truncate">
                      {s.title_key}
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-accent tabular-nums shrink-0">
                    {s.reader_count} readers
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Chapter Velocity */}
      {velocity.length > 0 && (
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">
            Chapter Velocity (7d)
          </h2>
          <div className="flex items-end gap-1.5 h-32">
            {(() => {
              const max = Math.max(
                ...velocity.map(
                  (x: { total_dispatches: number }) => x.total_dispatches
                ),
                1
              );
              return velocity.map(
                (v: { date: string; total_dispatches: number }) => {
                  const h = Math.max(
                    4,
                    Math.round((v.total_dispatches / max) * 100)
                  );
                  return (
                    <div
                      key={v.date}
                      role="img"
                      aria-label={`${v.date}: ${v.total_dispatches} dispatches`}
                      className="flex-1 bg-accent/70 rounded-t-sm hover:bg-accent transition-colors"
                      style={{ height: `${h}%` }}
                      title={`${v.date}: ${v.total_dispatches} dispatches`}
                    />
                  );
                }
              );
            })()}
          </div>
          <div className="flex justify-between text-[10px] text-text-muted">
            <span>{velocity[0]?.date}</span>
            <span>{velocity[velocity.length - 1]?.date}</span>
          </div>
        </section>
      )}
    </PageShell>
  );
}
