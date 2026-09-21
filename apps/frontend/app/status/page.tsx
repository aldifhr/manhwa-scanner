"use client";

import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";

const badge = (s: string) =>
  s?.toLowerCase() === "healthy"
    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
    : s?.toLowerCase() === "degraded" || s?.toLowerCase() === "rate_limited"
      ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
      : "text-red-400 bg-red-500/10 border-red-500/20";

export default function StatusPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["sources-health"],
    queryFn: async () => (await readerFetch<{ success: boolean; data: { sources: any[] } }>("/api/v1/sources/health")).data,
    refetchInterval: 15000,
  });
  const sources: any[] = (data as any)?.sources ?? (Array.isArray(data) ? data : []) ?? [];
  // fallback to cron/health if sources/health empty
  const { data: cron } = useQuery({
    queryKey: ["cron-health-fallback"],
    queryFn: async () => (await readerFetch<{ success: boolean; data: any }>("/api/v1/cron/health")).data,
    enabled: !isLoading && sources.length === 0,
  });
  const list = sources.length ? sources : (cron as any)?.sources ?? [];

  return (
    <PageShell>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Status</h1>
        <span className="text-xs text-white/40">3 sources • refresh 15s</span>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-32 rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-300 text-sm">{(error as Error).message}</div>
      ) : list.length === 0 ? (
        <div className="text-center py-12 text-white/50">No health data</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {list.map((s: any) => (
            <div key={s.name || s.source} className="bg-surface border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold capitalize text-white">{s.name || s.source}</span>
                <span className={`px-2 py-1 text-xs rounded-full border font-medium ${badge(s.status)}`}>{s.status || "unknown"}</span>
              </div>
              <div className="space-y-1 text-xs text-white/60">
                <div>Last scrape: <span className="text-white">{s.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : s.lastScrape ? new Date(s.lastScrape).toLocaleString() : "—"}</span></div>
                <div>Consecutive failures: <span className="text-white">{s.consecutiveFailures ?? 0}</span></div>
                <div>Error rate 24h: <span className="text-white">{s.errorRate24h ?? s.errorRate ?? "0"}%</span></div>
                {s.lastError && <div className="text-red-300 break-words">Error: {String(s.lastError).slice(0,120)}</div>}
                {s.responseTimeMs !== undefined && <div>Response: {s.responseTimeMs}ms</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
