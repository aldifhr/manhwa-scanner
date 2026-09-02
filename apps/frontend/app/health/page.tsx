"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHealthDetailed } from "@/lib/api";

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

interface HealthData {
  sources: SourceHealth[];
  overall: "healthy" | "degraded" | "down";
  uptime: number;
  version: string;
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <p className="text-red-400">Failed to load health data</p>
        </div>
      </div>
    );
  }

  const health = data as HealthData;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Health Dashboard</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted">Overall:</span>
          <span
            className={`px-3 py-1 rounded-full text-xs font-medium ${statusColors[health.overall]} text-white`}
          >
            {statusLabels[health.overall]}
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
            className="bg-surface rounded-lg p-4 border border-border flex items-center justify-between"
          >
            <div className="flex items-center gap-4">
              <div
                className={`w-3 h-3 rounded-full ${statusColors[source.status]}`}
              />
              <div>
                <p className="font-medium capitalize">{source.name}</p>
                <p className="text-sm text-text-muted">
                  Last scrape:{" "}
                  {source.lastScrape
                    ? new Date(source.lastScrape).toLocaleString()
                    : "Never"}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm text-text-muted">24h Error Rate</p>
              <p
                className={`font-bold ${source.errorRate24h > 10 ? "text-red-400" : "text-green-400"}`}
              >
                {source.errorRate24h.toFixed(1)}%
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
