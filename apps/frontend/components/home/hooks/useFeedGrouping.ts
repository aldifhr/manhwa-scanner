"use client";
import { useMemo } from "react";
import {
  groupChapters,
  seriesHasNewWithin,
  type GroupedSeries,
} from "@/lib/groupChapters";
import type { FlatChapter } from "@/lib/feed";
import { compareFlatByNewest } from "@/lib/feed";

export function useFeedGrouping(
  filtered: FlatChapter[] | undefined,
  opts: {
    pinnedSet: Set<string>;
    sortMode: "newest" | "title";
    view: "all" | "fav";
  }
) {
  const { pinnedSet, sortMode, view } = opts;
  const safeFiltered = (filtered ?? []) as FlatChapter[];

  const grouped = useMemo<GroupedSeries[]>(() => {
    let groups = groupChapters(safeFiltered);
    if (view === "fav")
      groups = groups.filter((g) => pinnedSet.has(g.titleKey));
    if (sortMode === "title")
      groups.sort(
        (a, b) =>
          a.title.localeCompare(b.title) || a.titleKey.localeCompare(b.titleKey)
      );
    else {
      groups.sort((a, b) => {
        const latestA = a.chapters.reduce((mx, c) => {
          const t = c.createdAt ? Date.parse(c.createdAt) : NaN;
          return !isNaN(t) && t > mx ? t : mx;
        }, 0);
        const latestB = b.chapters.reduce((mx, c) => {
          const t = c.createdAt ? Date.parse(c.createdAt) : NaN;
          return !isNaN(t) && t > mx ? t : mx;
        }, 0);
        if (latestB !== latestA) return latestB - latestA;
        return a.titleKey.localeCompare(b.titleKey);
      });
    }
    if (pinnedSet.size > 0 && view !== "fav")
      groups.sort(
        (a, b) =>
          Number(pinnedSet.has(b.titleKey)) - Number(pinnedSet.has(a.titleKey))
      );
    return groups;
  }, [filtered, pinnedSet, sortMode, view]);

  const flatDisplay = useMemo(() => {
    if (view === "fav")
      return safeFiltered.filter((c) => pinnedSet.has(c.titleKey));
    let arr: FlatChapter[];
    if (sortMode === "title")
      arr = [...safeFiltered].sort(
        (a, b) => a.title.localeCompare(b.title) || compareFlatByNewest(a, b)
      );
    else arr = [...safeFiltered].sort(compareFlatByNewest);
    if (pinnedSet.size === 0) return arr;
    arr.sort(
      (a, b) =>
        Number(pinnedSet.has(b.titleKey)) - Number(pinnedSet.has(a.titleKey))
    );
    return arr;
  }, [filtered, pinnedSet, view, sortMode]);

  const newSeriesKeys = useMemo(() => {
    const s = new Set<string>();
    for (const g of grouped) if (seriesHasNewWithin(g, 24)) s.add(g.titleKey);
    return s;
  }, [grouped]);

  return { grouped: grouped ?? [], flatDisplay: flatDisplay ?? [], newSeriesKeys } as const;
}
