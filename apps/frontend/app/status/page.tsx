"use client";

import { PageShell } from "@/components/PageShell";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { getHealthDetailed } from "@/lib/api";
import { readerFetch } from "@/lib/reader/transport";
import { useState } from "react";

interface SourceHealth {
  name: string;
  status: "healthy" | "degraded" | "down";
  lastScrape: string;
  lastSuccess: string;
  errorRate24h: number;
  consecutiveFailures: number;
  lastError: string | null;
  disabledUntil: string | null;
}

interface VoratoonCover {
  title_key: string;
  title: string;
  cover: string;
  expiry: string;
  hours_remaining: number;
  expiring_soon: boolean;
  expired: boolean;
}

interface HealthData {
  sources: SourceHealth[];
  overall: "healthy" | "degraded" | "down";
  uptime: number;
  version: string;
  voratoon_covers?: VoratoonCover[];
}

const statusColors = {
  healthy: "bg-green-500",
  degraded: "bg-yellow-500",
  down: "bg-red-500",
};

const statusLabels = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
};

export default function HealthDashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["health-detailed"],
    queryFn: getHealthDetailed,
    refetchInterval: 30000,
  });
  const queryClient = useQueryClient();
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const { data: errorLogsData } = useQuery({
    queryKey: ["error-logs", "latest3"],
    queryFn: async () => {
      const res = await readerFetch<{
        success: boolean;
        data: {
          results: {
            id: string;
            level: string;
            source: string;
            message: string;
            created_at: string;
          }[];
        };
      }>("/api/v1/logs/errors?page=1&page_size=3");
      return res.data?.results ?? [];
    },
    refetchInterval: 60000,
  });
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await readerFetch<{
        success: boolean;
        data: { refreshed: number };
      }>("/api/v1/health/refresh-voratoon", { method: "POST" });
      return res;
    },
    onSuccess: (res) => {
      setRefreshMsg(`Refreshed ${res.data?.refreshed ?? 0} covers`);
      queryClient.invalidateQueries({ queryKey: ["health-detailed"] });
      setTimeout(() => setRefreshMsg(null), 3000);
    },
    onError: (e) => setRefreshMsg((e as Error).message.slice(0, 80)),
  });

  if (isLoading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
        </div>
      </PageShell>
    );
  }

  if (error || !data) {
    return (
      <PageShell>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="text-red-400">Failed to load health data</p>
        </div>
      </PageShell>
    );
  }

  const health = data as HealthData;

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-bold">Health Dashboard</h1>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs sm:text-sm text-text-muted">Overall:</span>
            <span
              className={`px-3 py-1 rounded-full text-xs font-medium ${statusColors[health.overall]} text-white`}
            >
              {statusLabels[health.overall]}
            </span>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-surface rounded-lg p-4 border border-border">
            <p className="text-sm text-text-muted">Uptime</p>
            <p className="text-2xl font-bold">{health.uptime.toFixed(1)}%</p>
          </div>
          <div className="bg-surface rounded-lg p-4 border border-border">
            <p className="text-sm text-text-muted">Sources</p>
            <p className="text-2xl font-bold">{health.sources.length}</p>
          </div>
          <div className="bg-surface rounded-lg p-4 border border-border">
            <p className="text-sm text-text-muted">Healthy</p>
            <p className="text-2xl font-bold text-green-400">
              {health.sources.filter((s) => s.status === "healthy").length}
            </p>
          </div>
          <div className="bg-surface rounded-lg p-4 border border-border">
            <p className="text-sm text-text-muted">Issues</p>
            <p className="text-2xl font-bold text-red-400">
              {health.sources.filter((s) => s.status !== "healthy").length}
            </p>
          </div>
        </div>

        {/* Source List */}
        <div className="space-y-3">
          {health.sources.map((source) => (
            <div
              key={source.name}
              className="bg-surface rounded-lg p-3 sm:p-4 border border-border flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
                <div
                  className={`w-3 h-3 rounded-full shrink-0 ${statusColors[source.status]}`}
                />
                <div className="min-w-0">
                  <p className="font-medium capitalize text-sm sm:text-base truncate">
                    {source.name}
                  </p>
                  <p className="text-xs sm:text-sm text-text-muted truncate">
                    Last scrape:{" "}
                    {source.lastScrape
                      ? new Date(source.lastScrape).toLocaleString()
                      : "Never"}
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs sm:text-sm text-text-muted">24h Error</p>
                <p
                  className={`font-bold text-sm sm:text-base ${source.errorRate24h > 10 ? "text-red-400" : "text-green-400"}`}
                >
                  {source.errorRate24h.toFixed(1)}%
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Voratoon Cover Expiry */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              Voratoon Covers — expiry countdown
              <span className="text-xs font-normal text-text-muted">
                ({health.voratoon_covers?.length ?? 0} whitelist • auto-refresh
                5d / expiring &lt;24h)
              </span>
            </h2>
            <button
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition-colors min-h-0 min-w-0"
            >
              {refreshMutation.isPending
                ? "Refreshing..."
                : "Refresh expiring now"}
            </button>
          </div>
          {refreshMsg && <p className="text-xs text-amber-300">{refreshMsg}</p>}
          {!health.voratoon_covers || health.voratoon_covers.length === 0 ? (
            <p className="text-sm text-white/40 border border-dashed border-white/10 rounded-lg p-4 text-center">
              No voratoon covers — whitelist voratoon kosong atau semua fresh
              (gak ada yang expiring &lt;24h). Tombol Refresh tetep bisa
              dipencet buat force refresh mismatched cover kayak The Regressor.
            </p>
          ) : (
            <div className="grid gap-2">
              {health.voratoon_covers.map((c) => {
                const hours = c.hours_remaining ?? 0;
                const countdown =
                  hours < 0
                    ? `Expired ${Math.abs(hours).toFixed(1)}h ago`
                    : hours < 24
                      ? `${hours.toFixed(1)}h left`
                      : `${(hours / 24).toFixed(1)}d left`;
                return (
                  <div
                    key={c.title_key}
                    className={`rounded-lg p-3 border flex items-center justify-between gap-3 ${
                      c.expired
                        ? "bg-red-500/10 border-red-500/30"
                        : c.expiring_soon
                          ? "bg-yellow-500/10 border-yellow-500/30"
                          : "bg-surface border-border"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className="text-sm font-medium truncate"
                        title={c.title}
                      >
                        {c.title || c.title_key}
                      </p>
                      <p className="text-xs text-text-muted truncate">
                        {c.title_key} • expiry{" "}
                        {c.expiry ? new Date(c.expiry).toLocaleString() : "—"}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p
                        className={`text-sm font-bold ${
                          c.expired
                            ? "text-red-400"
                            : c.expiring_soon
                              ? "text-yellow-400"
                              : "text-green-400"
                        }`}
                      >
                        {countdown}
                      </p>
                      <p className="text-[11px] text-text-muted">
                        {c.expired
                          ? "expired"
                          : c.expiring_soon
                            ? "expiring soon"
                            : "fresh"}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Latest Errors */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-base sm:text-lg font-semibold">
              Latest Errors
            </h2>
            <a
              href="/error-logs"
              className="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-colors min-h-0 min-w-0"
            >
              View all →
            </a>
          </div>
          {!errorLogsData || errorLogsData.length === 0 ? (
            <p className="text-sm text-white/40 border border-dashed border-white/10 rounded-lg p-4 text-center">
              No errors — clean!
            </p>
          ) : (
            <div className="space-y-2">
              {errorLogsData.map((log) => (
                <div
                  key={log.id}
                  className="bg-surface rounded-lg p-3 border border-border"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded font-bold ${log.level === "error" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"}`}
                    >
                      {log.level}
                    </span>
                    <span className="text-white/50 truncate">{log.source}</span>
                    <span className="ml-auto text-white/30 text-[11px]">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-white/80 mt-1 break-words line-clamp-2">
                    {log.message}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
