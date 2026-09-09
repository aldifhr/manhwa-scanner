"use client";
import { PageShell } from "@/components/PageShell";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";
import { Reader } from "@/lib/reader";
import { useState } from "react";
import Link from "next/link";

async function getHealthDetailed() {
  const r = await readerFetch<{ success: boolean; data: unknown }>(
    "/api/v1/health/detailed"
  );
  return (r as unknown as { data: unknown }).data as unknown;
}

export default function AdminDashboard() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const { data: health, isLoading: hLoading } = useQuery({
    queryKey: ["admin-health"],
    queryFn: getHealthDetailed,
    refetchInterval: 30000,
  });
  const { data: queue } = useQuery({
    queryKey: ["admin-queue"],
    queryFn: async () => {
      const r = await readerFetch<{ success: boolean; data: any }>(
        "/api/v1/queue/status"
      );
      return r.data;
    },
    refetchInterval: 15000,
  });
  const { data: snapshot } = useQuery({
    queryKey: ["admin-snapshot"],
    queryFn: async () => {
      const r = await readerFetch<{ success: boolean; data: any }>(
        "/api/v1/dashboard/snapshot"
      );
      return r.data;
    },
    refetchInterval: 30000,
  });
  const cron =
    (snapshot as any)?.cronStatus ?? (snapshot as any)?.lastDelivery ?? {};
  const { data: errors } = useQuery({
    queryKey: ["admin-errors"],
    queryFn: async () => {
      const r = await readerFetch<{
        success: boolean;
        data: { results: any[] };
      }>("/api/v1/logs/errors?page=1&page_size=20");
      return (r.data?.results ?? []).filter((e: any) => e.level === "error").slice(0, 5);
    },
    refetchInterval: 60000,
  });
  const clearErrors = useMutation({
    mutationFn: async () => readerFetch<{ success: boolean }>("/api/v1/logs/errors", { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-errors"] }); setMsg("Logs cleared"); setTimeout(() => setMsg(null), 2000); },
    onError: (e) => setMsg((e as Error).message.slice(0, 120)),
  });

  const { data: failedQueue } = useQuery({
    queryKey: ["admin-failed-queue"],
    queryFn: Reader.getFailedDispatchesQueue,
    refetchInterval: 30000,
  });
  const { data: sourcesHealth } = useQuery({
    queryKey: ["admin-sources-health"],
    queryFn: Reader.getSourcesHealth,
    refetchInterval: 30000,
  });

  const cronRun = useMutation({
    mutationFn: async () => {
      const r = await readerFetch<{ success: boolean; data: any }>(
        "/api/cron?action=update",
        { method: "POST" }
      );
      return r;
    },
    onSuccess: () => {
      setMsg("Cron triggered");
      setTimeout(() => setMsg(null), 3000);
      qc.invalidateQueries({ queryKey: ["admin-cron"] });
    },
    onError: (e) => setMsg((e as Error).message.slice(0, 120)),
  });
  const refreshVor = useMutation({
    mutationFn: async () => {
      const r = await readerFetch<{ success: boolean; data: any }>(
        "/api/v1/health/refresh-voratoon",
        { method: "POST" }
      );
      return r;
    },
    onSuccess: (r: any) => {
      setMsg(`Refreshed ${r.data?.refreshed ?? 0} covers`);
      setTimeout(() => setMsg(null), 3000);
      qc.invalidateQueries({ queryKey: ["admin-health"] });
    },
    onError: (e) => setMsg((e as Error).message.slice(0, 120)),
  });
  const resyncRatings = useMutation({
    mutationFn: async () => readerFetch<{ success: boolean }>("/api/cron?action=enrich", { method: "POST" }),
    onSuccess: () => { setMsg("Resync triggered"); setTimeout(() => setMsg(null), 3000); },
    onError: (e) => setMsg((e as Error).message.slice(0, 120)),
  });

  const { data: failed } = useQuery({
    queryKey: ["admin-failed"],
    queryFn: async () => {
      const r = await readerFetch<{ success: boolean; data: { results: any[]; total: number } }>("/api/v1/failed-dispatches?limit=20");
      return r.data;
    },
    refetchInterval: 30000,
  });
  const retryOne = useMutation({
    mutationFn: async (id: string) => readerFetch<{ success: boolean }>("/api/v1/failed-dispatches?action=retry", { method: "POST", body: JSON.stringify({ id }) }),
    onSuccess: () => { setMsg("Retried"); setTimeout(() => setMsg(null), 2000); qc.invalidateQueries({ queryKey: ["admin-failed"] }); },
    onError: (e) => setMsg((e as Error).message.slice(0, 120)),
  });
  const retryAll = useMutation({
    mutationFn: async () => readerFetch<{ success: boolean }>("/api/v1/failed-dispatches?action=retry-all", { method: "POST" }),
    onSuccess: () => { setMsg("Retry-all triggered"); setTimeout(() => setMsg(null), 2000); qc.invalidateQueries({ queryKey: ["admin-failed"] }); },
    onError: (e) => setMsg((e as Error).message.slice(0, 120)),
  });

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
          <span className="text-xs px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">
            protected
          </span>
        </div>
        {msg && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300">
            {msg}
          </div>
        )}

        {hLoading ? (
          <div className="skeleton h-24 rounded-xl" />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">Uptime</p>
              <p className="text-xl font-bold">
                {(health as any)?.uptime?.toFixed?.(1) ?? "—"}%
              </p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">Queue depth</p>
              <p className="text-xl font-bold">{(queue as any)?.depth ?? 0}</p>
              <p className="text-[11px] text-white/40">
                {(() => {
                  const bd = (queue as any)?.cron_breakdown;
                  if (!bd) return "";
                  const parts = Object.entries(bd).map(([k, v]) => `${v} ${k}`);
                  return parts.join(", ");
                })()}
              </p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">Sources</p>
              <p className="text-xl font-bold">
                {(health as any)?.sources?.length ?? 0}
              </p>
              <p className="text-[11px] text-white/40">
                {(health as any)?.overall ?? ""}
              </p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">Version</p>
              <p className="text-sm font-mono">
                {(health as any)?.version ?? "—"}
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => cronRun.mutate()}
            disabled={cronRun.isPending}
            className="inline-flex items-center justify-center text-xs leading-none px-3 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/20 text-amber-300 disabled:opacity-50"
          >
            {cronRun.isPending ? "..." : "Trigger cron update"}
          </button>
          <button
            onClick={() => refreshVor.mutate()}
            disabled={refreshVor.isPending}
            className="inline-flex items-center justify-center text-xs leading-none px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 disabled:opacity-50"
          >
            {refreshVor.isPending ? "..." : "Refresh Voratoon covers"}
          </button>
          <button
            onClick={() => resyncRatings.mutate()}
            disabled={resyncRatings.isPending}
            className="inline-flex items-center justify-center text-xs leading-none px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 disabled:opacity-50"
          >
            {resyncRatings.isPending ? "..." : "Resync ratings"}
          </button>
          <Link
            href="/error-logs"
            className="inline-flex items-center justify-center text-xs leading-none px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-center"
          >
            Error logs →
          </Link>
          <Link
            href="/cron"
            className="inline-flex items-center justify-center text-xs leading-none px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-center"
          >
            Cron jobs →
          </Link>
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-3">Chapters by Source (24h)</h3>
          {(() => {
            const srcData = (snapshot as any)?.chaptersBySource24h;
            if (!srcData || Object.keys(srcData).length === 0) {
              return <p className="text-xs text-white/40">No data</p>;
            }
            const counts = Object.values(srcData) as number[];
            const maxVal = Math.max(...counts);
            return (
              <div className="space-y-2">
                {Object.entries(srcData).map(([src, count]) => (
                  <div key={src} className="flex items-center gap-2">
                    <span className="text-xs text-white/60 w-20 capitalize">{src}</span>
                    <div className="flex-1 h-5 bg-black/30 rounded overflow-hidden">
                      <div
                        className="h-full bg-amber-500/60 rounded"
                        style={{ width: `${((count as number) / maxVal) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-white/50 w-8 text-right">{count as number}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        <div className="grid gap-3">
          <h2 className="text-sm font-semibold text-white/80">Sources</h2>
          <div className="space-y-2">
            {(health as any)?.sources?.map((s: any) => (
              <div
                key={s.name}
                className="flex items-center justify-between gap-3 bg-surface border border-border rounded-lg p-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${s.status === "healthy" ? "bg-emerald-500" : s.status === "degraded" ? "bg-amber-400" : "bg-red-500"}`}
                  />
                  <span className="text-sm font-medium capitalize truncate">
                    {s.name}
                  </span>
                  <span className="text-xs text-white/40 truncate hidden sm:inline">
                    {s.lastError ?? ""}
                  </span>
                </div>
                <span className="text-xs text-white/50">
                  {s.errorRate24h?.toFixed?.(1) ?? 0}% err •{" "}
                  {s.consecutiveFailures ?? 0} fail
                </span>
              </div>
            )) ?? <p className="text-sm text-white/40">No sources</p>}
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-3">Sources Health</h3>
          {(() => {
            const sh = sourcesHealth as any;
            if (!sh || (Array.isArray(sh) && sh.length === 0) || (!Array.isArray(sh) && Object.keys(sh).length === 0)) {
              return <p className="text-xs text-white/40">No data</p>;
            }
            const items = Array.isArray(sh) ? sh : sh.sources ?? Object.entries(sh).map(([name, v]: [string, any]) => ({ name, ...v }));
            return (
              <div className="space-y-2">
                {items.map((s: any) => (
                  <div key={s.name} className="flex items-center justify-between gap-3 bg-black/20 rounded-lg p-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${s.status === "healthy" ? "bg-emerald-500" : s.status === "degraded" ? "bg-amber-400" : "bg-red-500"}`} />
                      <span className="text-sm font-medium capitalize truncate">{s.name}</span>
                    </div>
                    <span className="text-xs text-white/50">
                      {s.errorRate24h?.toFixed?.(1) ?? 0}% err • {s.consecutiveFailures ?? 0} fail
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-3">Failed Dispatches Queue</h3>
          {(() => {
            const fq = failedQueue as any;
            if (!fq || (Array.isArray(fq) && fq.length === 0) || (!Array.isArray(fq) && !fq.items?.length && !fq.length)) {
              return <p className="text-xs text-white/40">No pending failures</p>;
            }
            const items = Array.isArray(fq) ? fq : fq.items ?? [];
            return (
              <div className="space-y-2 max-h-64 overflow-auto">
                {items.map((r: any) => (
                  <div key={r.id} className="flex items-center gap-2 text-xs bg-black/20 rounded-lg p-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-white/10 text-white/60 uppercase">{r.source}</span>
                    <span className="truncate flex-1">{r.title} — {r.chapter}</span>
                    <span className="text-white/40 hidden sm:inline truncate max-w-[160px]">{r.error?.slice(0, 80)}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/80">Latest errors (5)</h2>
            <button onClick={() => clearErrors.mutate()} disabled={clearErrors.isPending} className="text-xs px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-50">{clearErrors.isPending ? "..." : "Clear"}</button>
          </div>
          {!errors || errors.length === 0 ? (
            <p className="text-sm text-white/40 border border-dashed border-white/10 rounded-lg p-4 text-center">
              Clean
            </p>
          ) : (
            <div className="space-y-2">
              {errors.map((l: any) => (
                <div
                  key={l.id}
                  className="bg-surface border border-border rounded-lg p-3"
                >
                  <div className="flex gap-2 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded font-bold ${l.level === "error" ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"}`}
                    >
                      {l.level}
                    </span>
                    <span className="text-white/50 truncate">{l.source}</span>
                    <span className="ml-auto text-white/30 text-[11px]">
                      {new Date(l.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-white/80 mt-1 line-clamp-2 break-words">
                    {l.message}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Pending chapters ({(queue as any)?.pending_chapters?.length ?? 0})</h3>
            <button
              onClick={() => readerFetch("/api/v1/queue/pending", { method: "DELETE" }).then(() => qc.invalidateQueries({ queryKey: ["admin-queue"] }))}
              className="text-xs px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/20 text-amber-300"
            >
              Clear all
            </button>
          </div>
          {!(queue as any)?.pending_chapters?.length ? (
            <p className="text-xs text-white/40">No pending chapters</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-auto">
              {(queue as any).pending_chapters.map((c: any) => (
                <div key={c.id} className="flex items-center gap-2 text-xs bg-black/20 rounded-lg p-2">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-white/10 text-white/60 uppercase">{c.source}</span>
                  <span className="truncate flex-1">{c.title} — ch.{c.chapter}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Failed dispatches {(failed as any)?.total ? `(${(failed as any).total})` : ""}</h3>
            <button onClick={() => retryAll.mutate()} disabled={retryAll.isPending || !(failed as any)?.results?.length} className="text-xs px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/20 text-amber-300 disabled:opacity-50">{retryAll.isPending ? "..." : "Retry all"}</button>
          </div>
          {!(failed as any)?.results?.length ? <p className="text-xs text-white/40">No failures</p> : <div className="space-y-2">{(failed as any).results.map((r: any) => <div key={r.id} className="flex items-center gap-2 text-xs bg-black/20 rounded-lg p-2"><span className="truncate flex-1">{r.title} — {r.chapter}</span><span className="text-white/40 hidden sm:inline truncate max-w-[160px]">{r.error?.slice(0, 80)}</span><button onClick={() => retryOne.mutate(r.id)} disabled={retryOne.isPending} className="shrink-0 px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/10">Retry</button></div>)}</div>}
        </div>
      </div>
    </PageShell>
  );
}
