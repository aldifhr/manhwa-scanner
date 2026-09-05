"use client";
import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { getHealthDetailed, getStats, getQueueDepth } from "@/lib/api";
import { readerFetch } from "@/lib/reader/transport";
import Link from "next/link";

export default function AdminDashboard() {
  const { data: health, isLoading: hLoading } = useQuery({
    queryKey: ["admin-health"],
    queryFn: getHealthDetailed,
    refetchInterval: 30000,
  });
  const { data: stats } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: getStats,
    refetchInterval: 60000,
  });
  const { data: queue } = useQuery({
    queryKey: ["admin-queue"],
    queryFn: getQueueDepth,
    refetchInterval: 15000,
  });
  const { data: cron } = useQuery({
    queryKey: ["admin-cron"],
    queryFn: async () => {
      const r = await readerFetch<{ success: boolean; data: unknown }>(
        "/api/v1/cron/status"
      );
      return (r as any).data;
    },
    refetchInterval: 30000,
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
              <p className="text-xs text-text-muted">Queue</p>
              <p className="text-xl font-bold">{(queue as any)?.depth ?? 0}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">Whitelist</p>
              <p className="text-xl font-bold">
                {(stats as any)?.total ?? "—"}
              </p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted">Sources</p>
              <p className="text-xl font-bold">
                {(health as any)?.sources?.length ?? 0}
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-3">
          <h2 className="text-sm font-semibold text-white/80">Quick links</h2>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/status"
              className="text-xs px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10"
            >
              Health / Status
            </Link>
            <Link
              href="/whitelist"
              className="text-xs px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10"
            >
              Whitelist
            </Link>
            <Link
              href="/exclude-list"
              className="text-xs px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10"
            >
              Exclude List
            </Link>
            <Link
              href="/dispatch-history"
              className="text-xs px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10"
            >
              Dispatch History
            </Link>
            <Link
              href="/error-logs"
              className="text-xs px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10"
            >
              Error Logs
            </Link>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-2">Cron status</h3>
          <pre className="text-xs bg-black/30 rounded-lg p-3 overflow-auto max-h-64 text-white/70">
            {JSON.stringify(cron ?? {}, null, 2)}
          </pre>
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-2">Health raw</h3>
          <pre className="text-xs bg-black/30 rounded-lg p-3 overflow-auto max-h-64 text-white/70">
            {JSON.stringify(health ?? {}, null, 2)}
          </pre>
        </div>
      </div>
    </PageShell>
  );
}
