"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useThrottledCallback } from "@tanstack/react-pacer";
import { Reader } from "@/lib/reader";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/lib/useToast";
import type { FlatChapter } from "@/lib/feed";
import { compareFlatByNewest, chapterKey } from "@/lib/feed";

// Initial load fetches the whole 24h window in one shot (backend caps the
// SQL fetch at 1000 rows, our volume is ~327 chapters / ~250 series, so a
// single page-1 request returns everything). This avoids the old behaviour
// where only page 1 (limit 60) rendered and the header count fell back to
// that truncated slice — making the UI report "26 series / 31 chapters"
// instead of the real ~250. Infinite-scroll loadMore stays as a safety valve
// for the rare case total exceeds 1000.
const PAGE_SIZE = 1000;

export function useInfiniteFeed(opts: {
  sourceFilter: string | null;
  typeFilter: string | null;
  feed: "all" | "nowl" | "wl";
}) {
  const { sourceFilter, typeFilter, feed } = opts;
  const { toast } = useToast();
  const whitelistParam = feed === "wl";
  const exclude = undefined; // server strips JP

  const [page, setPage] = useState(1);
  const [allItems, setAllItems] = useState<FlatChapter[]>([]);
  const [backendHasMore, setBackendHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.rssFeedFlat(
      exclude,
      PAGE_SIZE,
      sourceFilter || null,
      whitelistParam,
      typeFilter && typeFilter !== "no_type" ? typeFilter : null
    ),
    queryFn: () =>
      Reader.getRssFlatPage(1, PAGE_SIZE, {
        exclude,
        whitelist: whitelistParam,
        source: sourceFilter || null,
        type: typeFilter && typeFilter !== "no_type" ? typeFilter : null,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (data && page === 1) {
      const sorted = [...(data.results as unknown as FlatChapter[])].sort(
        compareFlatByNewest
      );
      setAllItems(sorted);
      setBackendHasMore(data.hasMore);
    }
  }, [data, page]);

  const hasMore = backendHasMore;

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || isLoading) return;
    const next = page + 1;
    setLoadingMore(true);
    try {
      const res = await Reader.getRssFlatPage(next, PAGE_SIZE, {
        exclude,
        whitelist: whitelistParam,
        source: sourceFilter || null,
        type: typeFilter && typeFilter !== "no_type" ? typeFilter : null,
      });
      setAllItems((prev) => {
        const seen = new Set(prev.map((c) => chapterKey(c)));
        const incoming = (res.results as unknown as FlatChapter[]).filter(
          (c) => !seen.has(chapterKey(c))
        );
        return [...prev, ...incoming].sort(compareFlatByNewest);
      });
      setBackendHasMore(res.hasMore);
      setPage((p) => p + 1);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      toast("Failed to load more — check connection", "error");
    } finally {
      setLoadingMore(false);
    }
  }, [
    loadingMore,
    hasMore,
    isLoading,
    page,
    sourceFilter,
    whitelistParam,
    typeFilter,
    toast,
  ]);

  // reset on server-filter change only (whitelistParam, source, type)
  // feed=nowl vs all share same whitelistParam=false → client-only filter, no clear needed
  // Keep allItems populated (keepPreviousData) so filter buttons don't vanish mid-refetch
  useEffect(() => {
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    setBackendHasMore(true);
    setPage(1);
    setLoadingMore(false);
  }, [sourceFilter, typeFilter, whitelistParam]);

  // scroll posisi juga reset saat feed ganti (nowl) meski tidak refetch
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [feed]);

  // infinite scroll observer — callback ref biar re-attach tiap mount/unmount
  const loadingRef = useRef({ loadingMore, loadMore });
  loadingRef.current = { loadingMore, loadMore };
  const queryClient = useQueryClient();
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

  // prefetch next page when scrolled past 80% — THROTTLE (may drop intermediate scrolls)
  const throttledPrefetch = useThrottledCallback(
    () => {
      if (!hasMore || loadingMore) return;
      const scrolled = window.scrollY + window.innerHeight;
      const threshold = document.documentElement.scrollHeight * 0.8;
      if (scrolled >= threshold) {
        const next = page + 1;
        queryClient.prefetchQuery({
          queryKey: queryKeys.rssFeedFlat(
            exclude,
            PAGE_SIZE,
            sourceFilter || null,
            whitelistParam,
            typeFilter && typeFilter !== "no_type" ? typeFilter : null
          ),
          queryFn: () =>
            Reader.getRssFlatPage(next, PAGE_SIZE, {
              exclude,
              whitelist: whitelistParam,
              source: sourceFilter || null,
              type: typeFilter && typeFilter !== "no_type" ? typeFilter : null,
            }),
          staleTime: 15_000,
        });
      }
    },
    { wait: 300 }
  );
  useEffect(() => {
    window.addEventListener("scroll", throttledPrefetch, { passive: true });
    return () => window.removeEventListener("scroll", throttledPrefetch);
  }, [throttledPrefetch]);

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
  } as const;
}
