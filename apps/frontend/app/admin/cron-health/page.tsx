"use client";

import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";

const badge = (status: string) => status === "healthy" || status === "HEALTHY" || status === "closed" || status === "online"
  ? "text-emerald-400 bg-emerald-500/10"
  : status === "DEGRADED" || status === "RATE_LIMITED"
  ? "text-amber-400 bg-amber-500/10"
  : "text-red-400 bg-red-500/10";

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
      <section className="bg-surface border border-border rounded-xl p-4"><h2 className="font-semibold mb-3">Cron jobs</h2><div className="flex flex-wrap gap-2 mb-3"><span className="px-2 py-1 rounded bg-white/10 text-sm">Total: {queueData?.total ?? 0}</span>{Object.entries(breakdown).map(([action, count]) => <span className="px-2 py-1 rounded bg-white/10 text-sm" key={action}>{action}: {count}</span>)}</div><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-text-muted"><th className="py-2">Action</th><th>Source</th><th>Title</th><th>Attempts</th></tr></thead><tbody>{jobs.length === 0 ? <tr><td colSpan={4} className="py-4 text-center text-text-muted">No jobs in queue</td></tr> : jobs.map((job: any, i: number) => <tr className="border-b border-border/50" key={i}><td className="py-2 font-mono">{job.action || "—"}</td><td>{job.source || "—"}</td><td>{job.title || "—"}</td><td>{job.attempts > 0 ? job.attempts : "—"}</td></tr>)}</tbody></table></div></section>
      <section className="bg-surface border border-border rounded-xl p-4"><h2 className="font-semibold mb-3">Sources</h2><div className="space-y-2">{sources.map((s: any) => <div className="flex flex-wrap items-center gap-3 text-sm" key={s.name}><b className="w-24">{s.name}</b><span className={`px-2 py-1 rounded ${badge(s.status)}`}>{s.status}</span><span className="text-text-muted">{s.responseTimeMs ?? 0}ms</span><span className="text-text-muted">errors {s.errorRate24h ?? 0}%</span><span className="text-text-muted truncate">{s.lastError ?? "—"}</span></div>)}</div></section>
      <section className="bg-surface border border-border rounded-xl p-4"><h2 className="font-semibold mb-3">Circuit breakers</h2><div className="flex flex-wrap gap-2">{Object.entries(circuits).map(([name, status]) => <span className={`px-2 py-1 rounded text-sm ${badge(String(status))}`} key={name}>{name}: {String(status)}</span>)}</div></section>
      <section className="bg-surface border border-border rounded-xl p-4"><h2 className="font-semibold mb-3">Scheduler / Telegram</h2><p className="text-sm">Scheduler: <b>{data.scheduler?.alive ? "online" : "offline"}</b> · Telegram: <b>{data.telegram?.configured ? "configured" : "not configured"}</b></p><p className="text-xs text-text-muted mt-2">Queue: {JSON.stringify(queue.breakdown ?? {})}</p></section>
      <section className="bg-surface border border-border rounded-xl p-4"><h2 className="font-semibold mb-3">Failed dispatches</h2>{(data.failed ?? []).length === 0 ? <p className="text-sm text-text-muted">None</p> : <div className="space-y-2">{data.failed.map((f: any) => <p className="text-sm text-red-300" key={f.id}>{f.title_key} ch{f.chapter} · {f.error}</p>)}</div>}</section>
    </>}
  </div></PageShell>;
}
