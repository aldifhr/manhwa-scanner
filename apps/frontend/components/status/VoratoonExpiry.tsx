"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";

function parseVoratoonExpiry(cover: string): Date | null {
  try {
    const u = new URL(cover);
    const d = u.searchParams.get("X-Amz-Date");
    const e = parseInt(u.searchParams.get("X-Amz-Expires") || "518400", 10);
    if (!d) return null;
    // X-Amz-Date like 20260915T012930Z -> ISO
    const iso = d.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z");
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    return new Date(dt.getTime() + e * 1000);
  } catch {
    return null;
  }
}

function countdown(exp: Date | null): string {
  if (!exp) return "—";
  const diff = exp.getTime() - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3600000);
  if (h < 24) return `${h}h left`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h left`;
}

export default function VoratoonExpiry() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["voratoon-expiry"],
    queryFn: async () => {
      const res: any = await readerFetch<any>("/api/v1/rss?limit=100");
      const results: any[] = res?.data?.results ?? res?.results ?? [];
      // dedupe by titleKey to avoid duplicate keys like island-of-stars-and-chains-voratoon
      const seen = new Set<string>();
      const deduped: any[] = [];
      for (const r of results) {
        if ((r.source || "").toLowerCase() !== "voratoon") continue;
        const k = r.titleKey || r.title_key || r.title;
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(r);
        if (deduped.length >= 5) break;
      }
      return deduped;
    },
    refetchInterval: 60000,
  });

  const [feedback, setFeedback] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: async () => readerFetch<{ success: boolean; data?: any; error?: string }>("/api/v1/health/refresh-voratoon", { method: "POST" }),
    onSuccess: (res: any) => {
      const msg = res?.success ? `Refreshed ${res?.data?.refreshed ?? 0} covers` : res?.error || "Done";
      setFeedback(msg);
      setTimeout(() => setFeedback(null), 3000);
      qc.invalidateQueries({ queryKey: ["voratoon-expiry"] });
      qc.invalidateQueries({ queryKey: ["sources-health"] });
    },
    onError: (e: any) => {
      const m = e instanceof Error ? e.message : String(e);
      const isAuth = m.includes("401") || m.toLowerCase().includes("unauthorized");
      setFeedback(isAuth ? "Login required (401)" : m.slice(0, 80));
      setTimeout(() => setFeedback(null), 4000);
    },
  });

  const items = (data as any[]) ?? [];

  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-white">Voratoon Cover Expiry</h3>
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
          className="px-3 py-1.5 text-xs rounded-lg bg-white text-black font-medium hover:bg-white/90 disabled:opacity-50"
        >
          {mut.isPending ? "Refreshing…" : "Refresh cover"}
        </button>
      </div>
      {feedback && <div className={`text-xs px-3 py-1.5 rounded-lg border mb-3 ${feedback.includes("401") || feedback.toLowerCase().includes("login") ? "bg-amber-500/10 border-amber-500/20 text-amber-300" : feedback.toLowerCase().includes("refreshed") ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300" : "bg-red-500/10 border-red-500/20 text-red-300"}`}>{feedback}</div>}
      {isLoading ? (
        <div className="skeleton h-16 rounded-lg" />
      ) : items.length === 0 ? (
        <div className="text-sm text-white/50">No voratoon covers</div>
      ) : (
        <div className="space-y-2">
          {items.map((it: any, idx: number) => {
            const exp = parseVoratoonExpiry(it.cover || "");
            const cd = countdown(exp);
            const isExpired = cd === "expired";
            const isSoon = exp ? exp.getTime() - Date.now() < 24 * 3600000 : false;
            return (
              <div key={`${it.titleKey}-${it.source}-${idx}`} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white truncate">{it.title}</div>
                  <div className="text-xs text-white/50 truncate">{it.titleKey}</div>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full border font-medium ${isExpired ? "bg-red-500/20 text-red-400 border-red-500/20" : isSoon ? "bg-amber-500/20 text-amber-400 border-amber-500/20" : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"}`}>
                  {cd}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-white/40 mt-2">X-Amz-Date + 518400s (6d) • e.g. king-account 20260915 → 20260921 01:29</p>
    </div>
  );
}

export function getExpiryForTest(cover: string) {
  return parseVoratoonExpiry(cover);
}
