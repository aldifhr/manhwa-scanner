"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { usePacerThrottledScroll } from "@/lib/usePacerThrottles";
import { Reader } from "@/lib/reader";
import { queryKeys } from "@/lib/queryKeys";
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

  const [page, setPage] = useState(1);
  const [allItems, setAllItems] = useState<FlatChapter[]>([]);
  const [backendHasMore, setBackendHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // refs to avoid stale closure race
  const pageRef = useRef(page);
  const loadingRef2 = useRef(loadingMore);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { loadingRef2.current = loadingMore; }, [loadingMore]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.rssFeedFlat(
      exclude,
      PAGE_SIZE,
      sourceFilter || null,
      whitelistParam,
      typeFilter && typeFilter !== "no_type" ? typeFilter : null,
      1
    ),
    queryFn: () =>
      Reader.getRssFlatPage(1, PAGE_SIZE, {
        exclude,
        whitelist: whitelistParam,
        source: sourceFilter || null,
        type: typeFilter && typeFilter !== "no_type" ? typeFilter : null,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: false, // ponytail: refetch wipes loadMore pages; user pull-to-refresh instead
  });

  useEffect(() => {
    if (data && pageRef.current === 1) {
      setAllItems((prev) => {
        const newData = data.results as unknown as FlatChapter[];
        if (prev.length === 0) {
          return [...newData].sort(compareFlatByNewest);
        }
        // ponytail: append-only refetch — keep existing scroll position
        const existingKeys = new Set(prev.map((c) => chapterKey(c)));
        const trulyNew = newData.filter((c) => !existingKeys.has(chapterKey(c)));
        if (trulyNew.length === 0) return prev;
        return [...trulyNew, ...prev];
      });
      setBackendHasMore(data.hasMore);
    }
  }, [data]);

  const hasMore = backendHasMore;

  const loadMore = useCallback(async () => {
    if (loadingRef2.current || !hasMore || isLoading) return;
    const next = pageRef.current + 1;
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
      setPage(next);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      toast("Failed to load more — check connection", "error");
    } finally {
      setLoadingMore(false);
    }
  }, [
    hasMore,
    isLoading,
    sourceFilter,
    whitelistParam,
    typeFilter,
    toast,
  ]);

  // reset on server-filter change only (whitelistParam, source, type)
  // feed=nowl vs all share same whitelistParam=false → client-only filter, no clear needed
  // Keep allItems populated (keepPreviousData) so filter buttons don't vanish mid-refetch
  // ponytail: reset allItems only after refetch — don't clear here, data effect replaces when page 1
  useEffect(() => {
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    setBackendHasMore(true);
    setPage(1);
    pageRef.current = 1;
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

  // cleanup observer on unmount (leak fix)
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, []);

  // prefetch next page when scrolled past 80% — THROTTLE (may drop intermediate scrolls)
  const throttledPrefetch = usePacerThrottledScroll(() => {
    if (!hasMore || loadingRef2.current) return;
    const scrolled = window.scrollY + window.innerHeight;
    const threshold = document.documentElement.scrollHeight * 0.8;
    if (scrolled >= threshold) {
      const next = pageRef.current + 1;
      queryClient.prefetchQuery({
        queryKey: queryKeys.rssFeedFlat(
          exclude,
          PAGE_SIZE,
          sourceFilter || null,
          whitelistParam,
          typeFilter && typeFilter !== "no_type" ? typeFilter : null,
          next
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
  }, 300);
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
