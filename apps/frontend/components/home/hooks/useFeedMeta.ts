"use client";
import { useMemo } from "react";
import type { FlatChapter } from "@/lib/feed";

export function useFeedMeta(
  all: FlatChapter[],
  optimisticWhitelist: Set<string>
) {
  const sources: string[] = useMemo(() => ["ikiru", "shinigami", "voratoon"], []);
  const typeCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of all) {
      const raw = String(c.type || "").toLowerCase().trim();
      const t = raw === "manhwa" || raw === "manhua" ? raw : "no_type";
      map[t] = (map[t] || 0) + 1;
    }
    return map;
  }, [all]);
  const wlCount = useMemo(() => {
    const wlSet = new Set<string>();
    for (const c of all) {
      if (
        c.isWhitelisted ||
        optimisticWhitelist.has(`${c.titleKey}:${c.source}`)
      )
        wlSet.add(c.titleKey);
    }
    return wlSet.size;
  }, [all, optimisticWhitelist]);
  const distinctTotal = useMemo(
    () => new Set(all.map((c) => c.titleKey)).size,
    [all]
  );
  return {
    sources,
    typeCounts,
    wlCount,
    nowlCount: distinctTotal - wlCount,
    distinctTotal,
  };
}
