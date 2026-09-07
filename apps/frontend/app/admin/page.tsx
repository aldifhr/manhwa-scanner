"use client";
import { PageShell } from "@/components/PageShell";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";
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
          <Link
            href="/error-logs"
            className="inline-flex items-center justify-center text-xs leading-none px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-center"
          >
            Error logs →
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
