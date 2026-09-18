"use client";
import { useEffect, useCallback, useRef, useMemo } from "react";
import {
  useInfiniteQuery,
} from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import { queryKeys, staleTimes, gcTimes } from "@/lib/queryKeys";
import { useToast } from "@/lib/useToast";
import type { FlatChapter } from "@/lib/feed";
import { compareFlatByNewest, chapterKey } from "@/lib/feed";

// ponytail: public /rss hard cap 100 (was 1000) — so first page is 100, rest via infinite scroll
// 24h volume ~327 chapters still fits in 4 pages; was single 1000 fetch before P1 hardening.
const PAGE_SIZE = 100;

export function useInfiniteFeed(opts: {
  sourceFilter: string | null;
  typeFilter: string | null;
  feed: "all" | "nowl" | "wl";
}) {
  const { sourceFilter, typeFilter, feed } = opts;
  const { toast } = useToast();
  const whitelistParam = feed === "wl";
  const exclude = undefined; // server strips JP
  const typeParam = typeFilter && typeFilter !== "no_type" ? typeFilter : null;

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: [
      "rss-feed-flat-infinite",
      exclude ?? "",
      PAGE_SIZE,
      sourceFilter || "all",
      whitelistParam,
      typeParam ?? "all",
    ] as const,
    queryFn: ({ pageParam }) =>
      Reader.getRssFlatPage(pageParam as number, PAGE_SIZE, {
        exclude,
        whitelist: whitelistParam,
        source: sourceFilter || null,
        type: typeParam,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.page + 1) : undefined,
    staleTime: staleTimes.rss,
    gcTime: gcTimes.rss,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  // Flatten, dedup, sort — single source of truth derived from cache
  const allItems = useMemo(() => {
    if (!data?.pages) return [];
    const seen = new Set<string>();
    const flat: FlatChapter[] = [];
    for (const pg of data.pages) {
      for (const c of ((pg?.results ?? []) as unknown as FlatChapter[])) {
        const k = chapterKey(c);
        if (!seen.has(k)) {
          seen.add(k);
          flat.push(c);
        }
      }
    }
    return flat.sort(compareFlatByNewest);
  }, [data]);

  const hasMore = hasNextPage ?? false;
  const loadingMore = isFetchingNextPage;

  // Keep derived page number for backward compat (last fetched page)
  const page = data?.pages?.length ?? 1;

  const loadMore = useCallback(async () => {
    if (!hasNextPage || isFetchingNextPage || isLoading) return;
    try {
      await fetchNextPage();
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      toast("Failed to load more — check connection", "error");
    }
  }, [hasNextPage, isFetchingNextPage, isLoading, fetchNextPage, toast]);

  // reset scroll on server-filter change only (whitelistParam, source, type)
  useEffect(() => {
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, [sourceFilter, typeParam, whitelistParam]);

  // scroll posisi juga reset saat feed ganti (nowl) meski tidak refetch
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [feed]);

  // infinite scroll observer — callback ref biar re-attach tiap mount/unmount
  const loadingRef = useRef({ loadingMore, loadMore });
  loadingRef.current = { loadingMore, loadMore };
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (!node || !hasMore) return;
      observerRef.current = new IntersectionObserver(
        (entries) => {
          const { loadingMore: busy, loadMore: doLoad } = loadingRef.current;
          if (entries[0]?.isIntersecting && !busy) doLoad();
        },
        { rootMargin: "600px 0px", threshold: 0 }
      );
      observerRef.current.observe(node);
    },
    [hasMore]
  );

  // cleanup observer on unmount (leak fix)
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, []);

  return {
    allItems,
    sentinelRef,
    hasMore,
    loadingMore,
    loadMore,
    isLoading,
    isFetching,
    error,
    refetch,
    page,
    PAGE_SIZE,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } as const;
}
