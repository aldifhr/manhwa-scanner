"use client";
import { PageShell } from "@/components/PageShell";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getHealthDetailed } from "@/lib/api";
import { readerFetch } from "@/lib/reader/transport";
import { useState } from "react";
import Link from "next/link";

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
        "/api/v1/queue"
      );
      return r.data;
    },
    refetchInterval: 15000,
  });
  const { data: cron } = useQuery({
    queryKey: ["admin-cron"],
    queryFn: async () => {
      const r = await readerFetch<{ success: boolean; data: any }>(
        "/api/v1/cron/status"
      );
      return r.data;
    },
    refetchInterval: 30000,
  });
  const { data: errors } = useQuery({
    queryKey: ["admin-errors"],
    queryFn: async () => {
      const r = await readerFetch<{
        success: boolean;
        data: { results: any[] };
      }>("/api/v1/logs/errors?page=1&page_size=5");
      return r.data?.results ?? [];
    },
    refetchInterval: 60000,
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
                DLQ {(queue as any)?.dlq ?? 0}
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
            className="text-xs px-3 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/20 text-amber-300 disabled:opacity-50"
          >
            {cronRun.isPending ? "..." : "Trigger cron update"}
          </button>
          <button
            onClick={() => refreshVor.mutate()}
            disabled={refreshVor.isPending}
            className="text-xs px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 disabled:opacity-50"
          >
            {refreshVor.isPending ? "..." : "Refresh Voratoon covers"}
          </button>
          <Link
            href="/status"
            className="text-xs px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10"
          >
            Open /status
          </Link>
          <Link
            href="/error-logs"
            className="text-xs px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10"
          >
            Error logs →
          </Link>
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

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-white/80">
            Latest errors (5)
          </h2>
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
          <h3 className="text-sm font-semibold mb-2">Cron status</h3>
          <pre className="text-xs bg-black/30 rounded-lg p-3 overflow-auto max-h-64 text-white/70">
            {JSON.stringify(cron ?? {}, null, 2)}
          </pre>
        </div>
      </div>
    </PageShell>
  );
}
