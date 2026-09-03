"use client";

import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { getAnalyticsOverview, getAnalyticsEngagement } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type {
  AnalyticsOverview,
  AnalyticsEngagement,
} from "@/lib/types";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-surface rounded-lg p-4 border border-border">
      <p className="text-xs text-text-muted uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub ? <p className="text-xs text-text-muted mt-1">{sub}</p> : null}
    </div>
  );
}

const SOURCE_COLOR: Record<string, string> = {
  ikiru: "bg-emerald-500",
  shinigami: "bg-red-500",
  voratoon: "bg-orange-500",
};

function BarRow({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-text-muted w-24 truncate text-right">
        {label}
      </span>
      <div className="flex-1 h-2 bg-surface-hover rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color ?? "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-medium w-10 text-right">{value}</span>
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
  const isLoading = overviewQ.isLoading && engagementQ.isLoading;
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
          <p className="text-red-400 text-sm">
            Failed to load analytics overview —{" "}
            {overviewError instanceof Error ? overviewError.message : "unknown error"}
          </p>
          {engagementError ? (
            <p className="text-red-400/70 text-xs mt-2">
              Engagement also failed: {engagementError.message}
            </p>
          ) : null}
        </div>
      </PageShell>
    );
  }

  const maxDispatch =
    Math.max(...(overview.popular_series?.map((s) => s.dispatch_count) ?? [0]), 1);
  const maxGenre = Math.max(
    ...(overview.top_genres?.map((g) => g.count) ?? [0]),
    1
  );
  const maxRead = Math.max(
    ...(engagement?.most_read_series?.map((r) => r.reader_count) ?? [0]),
    1
  );

  return (
    <PageShell>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <span className="text-xs text-text-muted">
          {overview.generated_at
            ? new Date(overview.generated_at).toLocaleString()
            : ""}
        </span>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Dispatches (7d)"
          value={overview.chapter_velocity?.reduce((a, b) => a + (b.total_dispatches ?? 0), 0) ?? 0}
          sub={`${overview.chapter_velocity?.length ?? 0} days`}
        />
        <StatCard
          label="Whitelist growth (30d)"
          value={overview.whitelist_growth?.reduce((a, b) => a + (b.new_entries ?? 0), 0) ?? 0}
          sub="new series"
        />
        <StatCard
          label="Active readers (24h)"
          value={engagement?.active_sessions_24h ?? 0}
          sub="sessions"
        />
        <StatCard
          label="Failed (7d)"
          value={overview.failed_dispatch_stats?.still_failed ?? 0}
          sub={`${overview.failed_dispatch_stats?.total_failed ?? 0} total`}
        />
      </div>

      {/* Two-column: popular + genres */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-semibold">Popular series (7d)</h2>
          {overview.popular_series?.length ? (
            <div className="space-y-2">
              {overview.popular_series.slice(0, 10).map((s: any) => {
                const title = (s.title && s.title !== s.title_key ? s.title : s.title_key) as string;
                const isUuid = /^[0-9a-f ]{8} [0-9a-f]{4}/i.test(s.title_key) || /^[0-9a-f-]{36}$/i.test(s.title_key);
                const label = isUuid ? title.slice(0, 22) : (title || s.title_key).slice(0, 22);
                return (
                <BarRow
                  key={`${s.title_key}:${s.source}`}
                  label={`${label} · ${s.source}`}
                  value={s.dispatch_count}
                  max={maxDispatch}
                  color={SOURCE_COLOR[s.source] ?? "bg-accent"}
                />
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-text-muted">No data</p>
          )}
        </div>

        <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-semibold">Top genres</h2>
          {overview.top_genres?.length ? (
            <div className="space-y-2">
              {overview.top_genres.slice(0, 10).map((g) => (
                <BarRow key={g.genre} label={g.genre} value={g.count} max={maxGenre} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted">No data</p>
          )}
        </div>
      </div>

      {/* Velocity + source */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-semibold">Chapter velocity (7d)</h2>
          <div className="space-y-1.5">
            {overview.chapter_velocity?.length ? (
              overview.chapter_velocity.map((v) => (
                <div
                  key={v.date}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="text-text-muted">{v.date}</span>
                  <span className="font-medium">
                    {v.total_dispatches} ch · {v.unique_series} series
                  </span>
                </div>
              ))
            ) : (
              <p className="text-xs text-text-muted">No data</p>
            )}
          </div>
        </div>

        <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
          <h2 className="text-sm font-semibold">Source distribution (7d)</h2>
          <div className="space-y-2">
            {(() => {
              const maxSrc = Math.max(...(overview.source_distribution?.map((x) => x.count) ?? [1]), 1);
              return (overview.source_distribution ?? []).map((s) => {
                const pct = Math.round((s.count / maxSrc) * 100);
                return (
                  <div key={s.source} className="flex items-center gap-3">
                    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${SOURCE_COLOR[s.source] ?? "bg-accent"}`} />
                    <span className="capitalize text-xs text-text-muted w-20">{s.source}</span>
                    <div className="flex-1 h-2 bg-surface-hover rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${SOURCE_COLOR[s.source] ?? "bg-accent"}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-medium w-8 text-right">{s.count}</span>
                  </div>
                );
              });
            })()}
            {!overview.source_distribution?.length ? (
              <p className="text-xs text-text-muted">No data</p>
            ) : null}
          </div>
          <h3 className="text-sm font-semibold pt-2">Most read (continue-reading)</h3>
          {engagementError ? (
            <p className="text-xs text-amber-400">
              Engagement unavailable: {engagementError.message.slice(0, 120)}
            </p>
          ) : engagement?.most_read_series?.length ? (
            <div className="space-y-2">
              {engagement.most_read_series.slice(0, 8).map((r) => (
                <BarRow
                  key={r.title_key}
                  label={r.title_key.slice(0, 24)}
                  value={r.reader_count}
                  max={maxRead}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted">No reading data yet</p>
          )}
        </div>
      </div>

      {/* Whitelist growth */}
      <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
        <h2 className="text-sm font-semibold">Whitelist growth (30d)</h2>
        <div className="flex gap-1 items-end h-16">
          {(overview.whitelist_growth ?? []).slice(0, 30).reverse().map((d) => {
            const max = Math.max(
              ...(overview.whitelist_growth?.map((x) => x.new_entries) ?? [1]),
              1
            );
            const h = Math.max(4, Math.round((d.new_entries / max) * 56));
            return (
              <div
                key={d.date}
                className="flex-1 bg-accent rounded-t"
                style={{ height: `${h}px` }}
                title={`${d.date}: ${d.new_entries}`}
              />
            );
          })}
        </div>
        {!overview.whitelist_growth?.length ? (
          <p className="text-xs text-text-muted">No data</p>
        ) : null}
      </div>
    </PageShell>
  );
}
