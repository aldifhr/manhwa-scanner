"use client";

import { useQuery } from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import { decodeHtml, getChapterLabel, rewriteCoverUrl } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import StatCard from "@/components/ui/StatCard";
import { timeAgo } from "@/lib/timeAgo";
import { PageShell } from "@/components/PageShell";
import {
  ChartLineUp,
  Star,
  Books,
  ClockCounterClockwise,
} from "@phosphor-icons/react";

function BarRow({ label, count, pct, tone = "accent" }: {
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
          style={{ width: `${Math.min(100, pct)}%` }}
          role="img"
          aria-label={`${label}: ${count} (${pct}%)`}
        />
      </div>
    </div>
  );
}

export default function StatsCharts() {
  const { data: d, isLoading, error } = useQuery({
    queryKey: queryKeys.stats,
    queryFn: () => Reader.getStats() as Promise<import("@/lib/types").StatsData | null>,
    staleTime: 60_000,
  });

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

  if (error || !d) {
    return (
      <PageShell>
        <div className="text-sm text-danger bg-danger-dim border border-danger/30 rounded-xl p-4">
          Failed to load stats
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <h1 className="text-xl font-semibold tracking-tight text-text">Stats</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard iconComponent={Books} label="Catalog" value={d.total} sub="manga tracked" />
        <StatCard iconComponent={Star} label="Rated" value={d.rated} sub="has rating" />
        <StatCard
          iconComponent={ChartLineUp}
          label="Avg Rating"
          value={d.avgRating != null ? d.avgRating.toFixed(1) : "—"}
          sub="catalog avg"
        />
        <StatCard
          iconComponent={ClockCounterClockwise}
          label="Trends"
          value={d.trends.length}
          sub="days of data"
        />
      </div>

      {/* Distributions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Status */}
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">By Status</h2>
          {d.byStatus.length === 0 ? (
            <div className="text-xs text-text-muted">No data</div>
          ) : (
            d.byStatus.map((s) => (
              <BarRow
                key={s.label}
                label={s.label}
                count={s.count}
                pct={s.percentage}
                tone={s.label === "completed" ? "success" : s.label === "hiatus" ? "danger" : "accent"}
              />
            ))
          )}
        </section>

        {/* Source */}
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">By Source</h2>
          {d.bySource.length === 0 ? (
            <div className="text-xs text-text-muted">No data</div>
          ) : (
            d.bySource.map((s) => (
              <BarRow key={s.label} label={s.label} count={s.count} pct={s.percentage} />
            ))
          )}
        </section>
      </div>

      {/* Rating distribution */}
      <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
        <h2 className="text-sm font-semibold text-text">Rating Distribution</h2>
        {d.ratingDistribution.length === 0 ? (
          <div className="text-xs text-text-muted">No ratings yet</div>
        ) : (
          d.ratingDistribution.map((r) => (
            <BarRow key={r.label} label={`${r.label}★`} count={r.count} pct={r.percentage} tone="muted" />
          ))
        )}
      </section>

      {/* Top rated */}
      <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
        <h2 className="text-sm font-semibold text-text">Top Rated</h2>
        {d.topRated.length === 0 ? (
          <div className="text-xs text-text-muted">No ratings yet</div>
        ) : (
          <div className="space-y-2">
            {d.topRated.map((m) => (
              <div key={m.id} className="flex items-center gap-3">
                <div className="w-9 h-12 shrink-0 rounded-md overflow-hidden bg-surface border border-border">
                  {m.cover ? (
                    <img
                      src={rewriteCoverUrl(m.cover) || undefined}
                      alt={decodeHtml(m.title)}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs font-bold">
                      {decodeHtml(m.title).charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text truncate">{decodeHtml(m.title)}</div>
                </div>
                <span className="text-xs font-semibold text-amber-400 tabular-nums shrink-0">
                  {m.rating.toFixed(1)}★
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Trends */}
      {d.trends.length > 0 && (
        <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
          <h2 className="text-sm font-semibold text-text">Chapters Sent (trend)</h2>
          <div className="flex items-end gap-1.5 h-32">
            {(() => {
              const max = Math.max(...d.trends.map((x) => x.chapters), 1);
              return d.trends.map((t) => {
                const h = Math.max(4, Math.round((t.chapters / max) * 100));
                return (
                  <div
                    key={t.date}
                    role="img"
                    aria-label={`${t.date}: ${t.chapters} chapters`}
                    className="flex-1 bg-accent/70 rounded-t-sm hover:bg-accent transition-colors"
                    style={{ height: `${h}%` }}
                    title={`${t.date}: ${t.chapters} chapters`}
                  />
                );
              });
            })()}
          </div>
          <div className="flex justify-between text-[10px] text-text-muted">
            <span>{d.trends[0]?.date}</span>
            <span>{d.trends[d.trends.length - 1]?.date}</span>
          </div>
        </section>
      )}

      {/* Recent updates */}
      <section className="rounded-xl bg-surface border border-border p-5 space-y-3">
        <h2 className="text-sm font-semibold text-text">Recent Updates</h2>
        {d.recentUpdates.length === 0 ? (
          <div className="text-xs text-text-muted">No recent updates</div>
        ) : (
          <div className="space-y-2">
            {d.recentUpdates.map((u) => (
              <div key={u.id} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text truncate">{decodeHtml(u.title)}</div>
                  <div className="text-xs text-text-muted">
                    Ch. {getChapterLabel(u)} · {u.source} · {timeAgo(u.time)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
