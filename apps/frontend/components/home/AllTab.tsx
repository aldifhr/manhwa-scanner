import { useQuery } from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  Suspense,
} from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { queryKeys } from "@/lib/queryKeys";
import { normalizeOrigin } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { SkeletonGrid } from "@/components/SkeletonGrid";
import { ErrorFallback } from "@/components/ErrorFallback";
import EmptyState from "@/components/EmptyState";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useReadItems } from "./useReadItems";
import { useFeedGrouping } from "./hooks/useFeedGrouping";
import { useFeedMeta } from "./hooks/useFeedMeta";
import dynamic from "next/dynamic";
const AllCard = dynamic(() => import("./AllCard"), {
  ssr: false,
  loading: () => (
    <div className="skeleton h-28 rounded-xl border border-white/10" />
  ),
});
const GroupedSeriesCard = dynamic(() => import("./GroupedSeriesCard"), {
  ssr: false,
  loading: () => (
    <div className="skeleton h-28 rounded-xl border border-white/10" />
  ),
});
import VirtualizedList from "./VirtualizedList";
import AllTabFilters from "./AllTabFilters";
import {
  groupChapters,
  seriesHasNewWithin,
  type GroupedSeries,
} from "@/lib/groupChapters";
import { useUiStore } from "@/lib/uiStore";
import { useUiUrlSync } from "@/lib/useUiUrlSync";
import { usePacerDebouncedValue } from "@/lib/usePacerDebounce";
import { usePacerThrottledScroll } from "@/lib/usePacerThrottles";
import { PageShell } from "@/components/PageShell";
function normalizeTitleKey(k: string) {
  return (k || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
import { usePinnedSet } from "./hooks/usePinnedSet";
import { useInfiniteFeed } from "./hooks/useInfiniteFeed";
import { useFeedActions } from "./hooks/useFeedActions";
import AllTabHeader from "./AllTabHeader";
import AllTabToolbar from "./AllTabToolbar";
import InfiniteSentinel from "./InfiniteSentinel";
import type { FlatChapter } from "@/lib/feed";
import {
  KNOWN_ORIGINS,
  resolveSeriesUrl,
  compareFlatByNewest,
} from "@/lib/feed";

// re-export for external consumers (app/page.tsx)
export type { FlatChapter } from "@/lib/feed";

function AllTabInner() {
  const { readItems, toggleRead, toggleReadAll, markAllRead } = useReadItems();
  const searchParams = useSearchParams();
  const deepLinkSeries = searchParams.get("series");
  useUiUrlSync();

  // Zustand selectors: subscribe only to needed slices
  const feed = useUiStore((s) => s.feed);
  const groupMode = useUiStore((s) => s.groupMode);
  const sortMode = useUiStore((s) => s.sortMode);
  const view = useUiStore((s) => s.contentView);
  const sourceFilter = useUiStore((s) => s.sourceFilter);
  const countryFilter = useUiStore((s) => s.countryFilter);
  const typeFilter = useUiStore((s) => s.typeFilter);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const setFeed = useUiStore((s) => s.setFeed);
  const toggleGroupMode = useUiStore((s) => s.toggleGroupMode);
  const setSortMode = useUiStore((s) => s.setSortMode);
  const setSourceFilter = useUiStore((s) => s.setSourceFilter);
  const setCountryFilter = useUiStore((s) => s.setCountryFilter);
  const setTypeFilter = useUiStore((s) => s.setTypeFilter);
  const setSearchQuery = useUiStore((s) => s.setSearchQuery);
  const resetFilters = useUiStore((s) => s.resetFilters);

  // Debounced search input
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const debouncedLocalSearch = usePacerDebouncedValue(localSearch, 300);
  useEffect(() => {
    if (debouncedLocalSearch !== searchQuery)
      setSearchQuery(debouncedLocalSearch);
  }, [debouncedLocalSearch, searchQuery, setSearchQuery]);
  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  // Reusable hooks
  const { pinnedSet, togglePin } = usePinnedSet();
  const {
    allItems,
    sentinelRef,
    hasMore,
    loadingMore,
    loadMore,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useInfiniteFeed({
    sourceFilter,
    typeFilter,
    feed,
  });
  const {
    optimisticWhitelist,
    optimisticExcluded,
    excludingKey,
    addingKey,
    handleAdd,
    handleAddGroup,
    handleExclude,
    handleExcludeSeries,
  } = useFeedActions();

  const all = allItems;

  // "Sent to Discord" label
  const isSentAvailable =
    all.length > 0 && all.some((c) => c.isSent !== undefined);
  const { data: dispatchHistory } = useQuery({
    queryKey: queryKeys.dispatchHistory(),
    queryFn: () =>
      Reader.getDispatchHistory(1, 10000) as unknown as Promise<
        import("@/lib/types").DispatchHistoryItem[]
      >,
    staleTime: 300_000,
    refetchInterval: 300_000,
    enabled: all.length > 0 && !isSentAvailable,
  });
  const sentKeys = useMemo(() => {
    const s = new Set<string>();
    for (const h of dispatchHistory ?? []) {
      if (h.titleKey && h.source && h.chapter)
        s.add(`${h.titleKey}:${h.source}:${h.chapter}`);
    }
    return s;
  }, [dispatchHistory]);

  const filtered = useMemo(() => {
    let f = all;
    if (optimisticExcluded.size > 0)
      f = f.filter((c) => !optimisticExcluded.has(c.titleKey));
    if (sourceFilter) f = f.filter((c) => (c.source || "") === sourceFilter);
    if (typeFilter) {
      f = f.filter((c) => {
        const raw = String(c.type || "")
          .toLowerCase()
          .trim();
        const t = raw === "manhwa" || raw === "manhua" ? raw : "no_type";
        return t === typeFilter;
      });
    }
    if (countryFilter === "__unknown__")
      f = f.filter(
        (c) =>
          !KNOWN_ORIGINS.includes(
            normalizeOrigin(c.origin) as (typeof KNOWN_ORIGINS)[number]
          )
      );
    else if (countryFilter)
      f = f.filter((c) => normalizeOrigin(c.origin) === countryFilter);
    if (feed === "nowl")
      f = f.filter(
        (c) =>
          !(
            c.isWhitelisted ||
            optimisticWhitelist.has(`${c.titleKey}:${c.source}`) ||
            optimisticWhitelist.has(
              `${normalizeTitleKey(c.titleKey)}:${c.source}`
            )
          )
      );
    if (feed === "wl")
      f = f.filter(
        (c) =>
          c.isWhitelisted ||
          optimisticWhitelist.has(`${c.titleKey}:${c.source}`) ||
          optimisticWhitelist.has(
            `${normalizeTitleKey(c.titleKey)}:${c.source}`
          )
      );
    const q = searchQuery.trim().toLowerCase();
    if (q) f = f.filter((c) => (c.title || "").toLowerCase().includes(q));
    return f.map((c) => ({ ...c, seriesUrl: resolveSeriesUrl(c) }));
  }, [
    all,
    optimisticExcluded,
    sourceFilter,
    typeFilter,
    countryFilter,
    optimisticWhitelist,
    searchQuery,
    feed,
  ]);

  const deepLinkRef = useRef<HTMLDivElement | null>(null);
  const scrollKey = "alltab_scroll";
  const initialScrollOffset =
    typeof window !== "undefined"
      ? Number(localStorage.getItem(scrollKey) || "0")
      : undefined;

  const { grouped, flatDisplay, newSeriesKeys } = useFeedGrouping(filtered, {
    pinnedSet,
    sortMode,
    view,
  });

  const deepLinkLower = deepLinkSeries?.toLowerCase() ?? "";
  const groupedDeepLinkIndex = useMemo(() => {
    if (!deepLinkLower) return -1;
    return grouped.findIndex((s) => s.titleKey.toLowerCase() === deepLinkLower);
  }, [grouped, deepLinkLower]);
  const flatDeepLinkIndex = useMemo(() => {
    if (!deepLinkLower) return -1;
    return flatDisplay.findIndex(
      (c) => c.titleKey.toLowerCase() === deepLinkLower
    );
  }, [flatDisplay, deepLinkLower]);

  useEffect(() => {
    if (!groupMode || !deepLinkSeries || filtered.length === 0) return;
    const t = setTimeout(() => {
      const cards = document.querySelectorAll<HTMLElement>("[data-title-key]");
      const el =
        [...cards].find(
          (c) => (c.dataset.titleKey || "").toLowerCase() === deepLinkLower
        ) ?? deepLinkRef.current;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.classList.add(
        "ring-2",
        "ring-accent",
        "ring-offset-2",
        "ring-offset-background",
        "transition-all"
      );
      setTimeout(
        () =>
          el?.classList.remove(
            "ring-2",
            "ring-accent",
            "ring-offset-2",
            "ring-offset-background"
          ),
        2500
      );
    }, 300);
    return () => clearTimeout(t);
  }, [deepLinkSeries, deepLinkLower, filtered, groupMode]);

  useEffect(() => {
    const saved = Number(localStorage.getItem(scrollKey) || "0");
    if (saved > 0) {
      const t = setTimeout(() => window.scrollTo({ top: saved }), 200);
      return () => clearTimeout(t);
    }
  }, []);

  const throttledSaveScroll = usePacerThrottledScroll(() => {
    localStorage.setItem(scrollKey, String(window.scrollY));
  }, 250);
  useEffect(() => {
    window.addEventListener("scroll", throttledSaveScroll, { passive: true });
    return () => window.removeEventListener("scroll", throttledSaveScroll);
  }, [throttledSaveScroll]);

  // Derive counts from `filtered` (same data as displayed) — consistent with grouped.length
  const filteredDistinctTotal = useMemo(
    () => new Set(filtered.map((c) => c.titleKey)).size,
    [filtered]
  );
  const filteredWlCount = useMemo(
    () =>
      new Set(
        filtered
          .filter(
            (c) =>
              c.isWhitelisted ||
              optimisticWhitelist.has(`${c.titleKey}:${c.source}`)
          )
          .map((c) => c.titleKey)
      ).size,
    [filtered, optimisticWhitelist]
  );

  const {
    sources,
    typeCounts,
    countryCounts,
    wlCount: _wlCount,
    nowlCount: _nowlCount,
    unknownCount,
    distinctTotal: _distinctTotal,
  } = useFeedMeta(all, optimisticWhitelist);
  const distinctTotal = filteredDistinctTotal || _distinctTotal;
  const wlCount = filteredWlCount || _wlCount;
  const nowlCount = Math.max(0, distinctTotal - wlCount);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape" && typing) {
        (e.target as HTMLElement).blur();
        return;
      }
      if (typing) return;
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("home-search-input")?.focus();
      } else if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        window.scrollBy({
          top: e.key === "j" ? 320 : -320,
          behavior: "smooth",
        });
      } else if (e.key === "Escape") {
        resetFilters();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetFilters]);

  if (isLoading)
    return (
      <PageShell>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap">
            <div className="skeleton h-6 sm:h-7 w-28 sm:w-32 rounded" />
            <div className="skeleton h-7 w-36 sm:w-44 rounded-lg" />
            <div className="skeleton h-4 w-16 rounded" />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="skeleton h-10 flex-1 min-w-37.5 rounded-lg" />
          <div className="skeleton h-10 w-24 rounded-lg" />
          <div className="skeleton h-10 w-20 rounded-lg" />
        </div>
        <div className="sticky top-2 z-10 bg-black/80 backdrop-blur-md -mx-1 px-1 py-2 flex flex-col gap-2">
          <div className="flex gap-2 pb-1 -mx-1 px-1">
            <div className="skeleton h-7 w-28 rounded-full shrink-0" />
            <div className="skeleton h-7 w-24 rounded-full shrink-0" />
            <div className="skeleton h-7 w-24 rounded-full shrink-0" />
            <div className="skeleton h-7 w-24 rounded-full shrink-0" />
          </div>
          <div className="flex gap-2 flex-wrap">
            <div className="skeleton h-7 w-12 rounded-full" />
            <div className="skeleton h-7 w-14 rounded-full" />
            <div className="skeleton h-7 w-20 rounded-full" />
          </div>
        </div>
        <SkeletonGrid
          variant={groupMode ? "group-item" : "list-item"}
          hideHeader
        />
      </PageShell>
    );
  if (error)
    return (
      <PageShell>
        <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-white">
          All Manga
        </h1>
        <ErrorFallback
          title="Failed to load manga list"
          onRetry={() => refetch()}
        />
      </PageShell>
    );

  return (
    <PageShell>
      {/* Refetch indicator */}
      {isFetching && !isLoading && (
        <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-accent/50 animate-pulse" />
      )}
      <AllTabHeader
        feed={feed}
        setFeed={setFeed}
        distinctTotal={distinctTotal}
        wlCount={wlCount}
        nowlCount={nowlCount}
        groupedCount={groupMode ? grouped.length : flatDisplay.length}
        countLabel={groupMode ? "series" : "chapters"}
        hasData={all.length > 0}
      />
      <AllTabToolbar
        localSearch={localSearch}
        setLocalSearch={setLocalSearch}
        sortMode={sortMode}
        setSortMode={setSortMode}
        groupMode={groupMode}
        toggleGroupMode={toggleGroupMode}
      />
      <AllTabFilters
        sources={sources}
        countryCounts={countryCounts}
        typeCounts={typeCounts}
        unknownCount={unknownCount}
        countryFilter={countryFilter}
        sourceFilter={sourceFilter}
        typeFilter={typeFilter}
        setCountryFilter={setCountryFilter}
        setSourceFilter={setSourceFilter}
        setTypeFilter={setTypeFilter}
      />

      {grouped.length === 0 ? (
        hasMore || loadingMore ? (
          <div className="flex justify-center py-8">
            <span className="text-xs text-white/50 animate-pulse">
              Loading chapters…
            </span>
          </div>
        ) : (
          <EmptyState
            icon={<MagnifyingGlass />}
            message={view === "fav" ? "No favorites yet" : "No chapters found"}
            subMessage={
              view === "fav"
                ? "Click the Pin (📌) button on a card to add"
                : all.length > 0
                  ? "Filters hide all results — try clearing them"
                  : "Try adjusting the filters above"
            }
            action={
              all.length > 0 &&
              (sourceFilter ||
                typeFilter ||
                countryFilter ||
                searchQuery ||
                feed !== "all") ? (
                <button
                  onClick={resetFilters}
                  className="inline-flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-full bg-[var(--gold-accent)] text-black font-semibold hover:bg-[var(--gold-accent-hover)] transition-colors"
                >
                  Reset filters
                </button>
              ) : undefined
            }
          />
        )
      ) : groupMode ? (
        <VirtualizedList
          items={grouped}
          gap={12}
          estimateSize={186}
          overscan={6}
          initialScrollOffset={initialScrollOffset}
          scrollToTitleKey={deepLinkSeries}
          titleKeyOf={(s) => (s as GroupedSeries).titleKey}
          renderItem={(series, i) => {
            const s = series as GroupedSeries;
            const isRead =
              s.chapters.length > 0 &&
              s.chapters.every((c) => readItems.has(c.url));
            const isWL =
              s.isWhitelisted ||
              optimisticWhitelist.has(
                `${s.titleKey}:${s.chapters[0]?.source || ""}`
              );
            const isDeepMatch = i === groupedDeepLinkIndex;
            return (
              <div
                key={`${s.titleKey}-${i}`}
                data-title-key={s.titleKey}
                ref={
                  isDeepMatch
                    ? (deepLinkRef as unknown as React.RefObject<HTMLDivElement>)
                    : undefined
                }
                className={cn(
                  isDeepMatch &&
                    "ring-2 ring-[var(--gold-accent)] ring-offset-2 ring-offset-black rounded-xl"
                )}
              >
                <GroupedSeriesCard
                  series={s}
                  isRead={isRead}
                  isWhitelisted={isWL}
                  isNew={newSeriesKeys.has(s.titleKey)}
                  isPinned={pinnedSet.has(s.titleKey)}
                  unreadCount={
                    s.chapters.filter((c) => !readItems.has(c.url)).length
                  }
                  readCount={
                    s.chapters.filter((c) => readItems.has(c.url)).length
                  }
                  totalChapters={s.chapters.length}
                  adding={addingKey === s.titleKey}
                  onToggleRead={() =>
                    toggleReadAll(s.chapters.map((c) => c.url))
                  }
                  onTogglePin={() => togglePin(s.titleKey)}
                  onMarkRead={() => markAllRead(s.chapters.map((c) => c.url))}
                  onExclude={() => handleExcludeSeries(s)}
                  isExcluded={optimisticExcluded.has(s.titleKey)}
                  excluding={excludingKey === s.titleKey}
                  onAdd={() => handleAddGroup(s)}
                  isSentToDiscord={s.chapters.some(
                    (c) => c.isSent === true || sentKeys.has(c.key)
                  )}
                />
              </div>
            );
          }}
        />
      ) : (
        <VirtualizedList
          items={flatDisplay}
          initialScrollOffset={initialScrollOffset}
          gap={12}
          estimateSize={180}
          scrollToTitleKey={deepLinkSeries}
          titleKeyOf={(c) => c.titleKey}
          renderItem={(item, i) => {
            const isRead = readItems.has(item.url);
            const optKey = `${item.titleKey}:${item.source}`;
            const isWL = item.isWhitelisted || optimisticWhitelist.has(optKey);
            const isDeepMatch = i === flatDeepLinkIndex;
            return (
              <div
                data-title-key={item.titleKey}
                className={cn(
                  isDeepMatch &&
                    "ring-2 ring-accent ring-offset-2 ring-offset-background transition-all"
                )}
              >
                <AllCard
                  item={item}
                  isRead={isRead}
                  isWhitelisted={isWL}
                  isNew={newSeriesKeys.has(item.titleKey)}
                  adding={addingKey === item.titleKey}
                  onToggleRead={() => toggleRead(item.url)}
                  onAdd={() => handleAdd(item)}
                  isExcluded={optimisticExcluded.has(item.titleKey)}
                  excluding={excludingKey === item.titleKey}
                  isPinned={pinnedSet.has(item.titleKey)}
                  onTogglePin={() => togglePin(item.titleKey)}
                  onExclude={() => handleExclude(item)}
                  isSentToDiscord={
                    item.isSent === true ||
                    sentKeys.has(
                      `${item.titleKey}:${item.source}:${item.chapter}`
                    )
                  }
                />
              </div>
            );
          }}
        />
      )}

      <InfiniteSentinel
        ref={sentinelRef}
        hasMore={hasMore}
        loadingMore={grouped.length > 0 ? loadingMore : false}
        onLoadMore={loadMore}
        filteredLength={filtered.length}
        groupedLength={grouped.length}
      />
    </PageShell>
  );
}

export default function AllTab() {
  return (
    <Suspense fallback={<SkeletonGrid />}>
      <AllTabInner />
    </Suspense>
  );
}
