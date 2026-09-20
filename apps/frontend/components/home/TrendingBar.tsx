"use client";

import { useQuery } from "@tanstack/react-query";
import { Flame, Globe } from "@phosphor-icons/react";

type StatsRes = {
  success: boolean;
  data: {
    chapters_by_source_24h?: Record<string, number>;
    by_origin?: Record<string, number>;
    chapters_last_24h?: number;
    avg_chapters_per_day_7d?: number;
  };
};

async function fetchStats(): Promise<StatsRes> {
  const r = await fetch("/api/v1/public/stats", { cache: "no-store" });
  if (!r.ok) throw new Error("stats failed");
  return r.json();
}

export default function TrendingBar() {
  const { data } = useQuery({
    queryKey: ["public-stats-trending"],
    queryFn: fetchStats,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const byOrigin = data?.data?.by_origin || {};
  const bySource = data?.data?.chapters_by_source_24h || {};
  const total24 = data?.data?.chapters_last_24h ?? 0;

  if (!total24 && Object.keys(byOrigin).length === 0 && Object.keys(bySource).length === 0) return null;

  const originEntries = Object.entries(byOrigin).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sourceEntries = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <div className="mb-6 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="p-1 rounded bg-orange-500/15 border border-orange-500/20"><Flame size={12} className="text-orange-400" weight="fill" /></div>
        <span className="text-[11px] font-bold tracking-wide text-white/80">Trending 7d</span>
        {total24 ? <span className="text-[11px] text-white/40">• {total24} ch/24h • avg {data?.data?.avg_chapters_per_day_7d ?? 0}/d</span> : null}
      </div>

      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
        {/* by origin */}
        {originEntries.map(([origin, count]) => (
          <span key={origin} className="shrink-0 inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-white/70">
            <Globe size={12} className="text-white/40" /> {origin} <span className="text-white font-bold">{count}</span>
          </span>
        ))}
        <span className="shrink-0 w-px bg-white/10 mx-1" aria-hidden />
        {sourceEntries.map(([src, count]) => (
          <span key={src} className={`shrink-0 inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border capitalize ${src === "shinigami" ? "bg-red-500/10 border-red-500/20 text-red-300" : src === "voratoon" ? "bg-orange-500/10 border-orange-500/20 text-orange-300" : "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"}`}>
            {src} <span className="font-bold">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
