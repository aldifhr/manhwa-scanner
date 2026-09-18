"use client";

import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";

const badge = (status: string) => {
  const s = status?.toLowerCase();
  return s === "healthy" || s === "closed" || s === "online"
    ? "text-emerald-400 bg-emerald-500/10"
    : s === "degraded" || s === "rate_limited"
    ? "text-amber-400 bg-amber-500/10"
    : "text-red-400 bg-red-500/10";
};

export default function CronHealthPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["cron-health"],
    queryFn: async () => (await readerFetch<{ success: boolean; data: any }>("/api/cron/health")).data,
    refetchInterval: 15000,
  });
  const sources = data?.sources ?? [];
  const dispatch = data?.dispatch ?? {};
  const queue = data?.queue ?? {};
  const circuits = data?.circuits ?? {};
  const { data: queueData } = useQuery({
    queryKey: ["cron-list"],
    queryFn: async () => (await readerFetch<{ success: boolean; data: { total: number; jobs: any[] } }>("/api/v1/queue/cron")).data,
    refetchInterval: 10000,
  });
  const jobs = queueData?.jobs ?? [];
  const breakdown: Record<string, number> = {};
  for (const job of jobs) {
    const key = (job.action || "unknown").split(":")[0];
    breakdown[key] = (breakdown[key] || 0) + 1;
  }

  return <PageShell><div className="space-y-6">
    <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Cron Health</h1><span className="text-xs text-text-muted">refresh 15s</span></div>
    {isLoading && <div className="skeleton h-32 rounded-xl" />}
    {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-300">{(error as Error).message}</div>}
    {data && <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[["Sent 24h", dispatch.sent_24h], ["Failed 24h", dispatch.failed_24h], ["Queue", queue.depth], ["Total sent", dispatch.total]].map(([label, value]) => <div className="bg-surface border border-border rounded-xl p-4" key={String(label)}><p className="text-xs text-text-muted">{label}</p><p className="text-2xl font-bold">{value ?? 0}</p></div>)}
      </div>

      <section className="bg-surface border border-border rounded-xl p-4"><h2 className="font-semibold mb-3">Sources</h2><div className="space-y-2">{sources.map((s: any) => <div className="flex flex-wrap items-center gap-3 text-sm" key={s.name}><b className="w-24">{s.name}</b><span className={`px-2 py-1 rounded ${badge(s.status)}`}>{s.status}</span><span className="text-text-muted">{s.responseTimeMs ?? 0}ms</span><span className="text-text-muted">errors {s.errorRate24h ?? 0}%</span><span className="text-text-muted truncate">{s.lastError ?? "—"}</span></div>)}</div></section>
      <section className="bg-surface border border-border rounded-xl p-4"><h2 className="font-semibold mb-3">Circuit breakers</h2><div className="flex flex-wrap gap-2">{Object.entries(circuits).map(([name, status]) => <span className={`px-2 py-1 rounded text-sm ${badge(String(status))}`} key={name}>{name}: {String(status)}</span>)}</div></section>

    </>}
  </div></PageShell>;
}
