"use client";
import { useMemo } from "react";
import { normalizeOrigin } from "@/lib/constants";
import { KNOWN_ORIGINS } from "@/lib/feed";
import type { FlatChapter } from "@/lib/feed";

export function useFeedMeta(
  all: FlatChapter[],
  optimisticWhitelist: Set<string>
) {
  const sources = useMemo(
    () => [...new Set(all.map((c) => c.source).filter(Boolean))].sort(),
    [all]
  );
  const typeCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of all) {
      const raw = String(c.type || "").toLowerCase().trim();
      const t = raw === "manhwa" || raw === "manhua" ? raw : "no_type";
      map[t] = (map[t] || 0) + 1;
    }
    return map;
  }, [all]);
  const countryCounts = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const c of all) {
      const n = normalizeOrigin(c.origin);
      if (!n) continue;
      (map[n] ??= new Set()).add(c.titleKey);
    }
    const counts: Record<string, number> = {};
    for (const [k, set] of Object.entries(map)) counts[k] = set.size;
    return counts;
  }, [all]);
  const counts = useMemo(() => {
    const wlSet = new Set<string>();
    const unknownSet = new Set<string>();
    for (const c of all) {
      if (
        c.isWhitelisted ||
        optimisticWhitelist.has(`${c.titleKey}:${c.source}`)
      )
        wlSet.add(c.titleKey);
      if (
        !KNOWN_ORIGINS.includes(
          normalizeOrigin(c.origin) as (typeof KNOWN_ORIGINS)[number]
        )
      )
        unknownSet.add(c.titleKey);
    }
    return { wl: wlSet.size, unknown: unknownSet.size };
  }, [all, optimisticWhitelist]);
  const distinctTotal = useMemo(
    () => new Set(all.map((c) => c.titleKey)).size,
    [all]
  );
  return {
    sources,
    typeCounts,
    countryCounts,
    wlCount: counts.wl,
    nowlCount: distinctTotal - counts.wl,
    unknownCount: counts.unknown,
    distinctTotal,
  } as const;
}
