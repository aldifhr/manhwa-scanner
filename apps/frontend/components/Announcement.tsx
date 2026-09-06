"use client";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";

const DISMISS_KEY = "announcement_dismissed_at";
const DISMISS_TTL = 24 * 60 * 60 * 1000;

export default function Announcement() {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(DISMISS_KEY);
      if (v && Date.now() - Number(v) < DISMISS_TTL) setDismissed(true);
    } catch {}
  }, []);

  const { data: count } = useQuery({
    queryKey: ["announcement", "latest-count"],
    queryFn: async () => {
      const res = await fetch("/api/v1/reader/rss?limit=1&group=false", { cache: "no-store" });
      if (!res.ok) return null;
      const j = await res.json();
      const d = j?.data as { total?: number } | undefined;
      return d ?? null;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: health } = useQuery({
    queryKey: ["announcement", "health"],
    queryFn: async () => {
      const res = await fetch("/api/v1/dashboard/snapshot", { cache: "no-store" });
      if (!res.ok) return null;
      const j = await res.json();
      const h = j?.data?.sourceHealth as Record<string, { status: string }> | undefined;
      if (!h) return null;
      const degraded = Object.entries(h)
        .filter(([, v]) => v.status !== "healthy")
        .map(([k]) => k);
      return degraded;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (dismissed) return null;
  const total = count?.total ?? null;
  if (total == null && (!health || health.length === 0)) return null;

  const degraded = health && health.length > 0 ? ` • ${health.join(", ")} degraded` : "";

  return (
    <div className="w-full bg-[var(--gold-accent)] text-black text-center text-xs font-medium py-1.5 px-4 flex items-center justify-center gap-2">
      <span>
        🔥 {total ?? "?"} baru 24h{degraded}
      </span>
      <button
        aria-label="Dismiss"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
          } catch {}
          setDismissed(true);
        }}
        className="ml-2 inline-flex items-center justify-center w-5 h-5 rounded-full bg-black/10 hover:bg-black/20 text-black/60 hover:text-black transition-colors"
      >
        ×
      </button>
    </div>
  );
}
