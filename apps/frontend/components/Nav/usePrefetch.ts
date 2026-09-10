"use client";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, staleTimes } from "@/lib/queryKeys";
import { Reader } from "@/lib/reader";

export function usePrefetch() {
  const qc = useQueryClient();
  return (href: string) => {
    switch (href) {
      case "/":
        qc.prefetchQuery({
          queryKey: queryKeys.dashboardSnapshot,
          queryFn: () => Reader.getDashboardSnapshot() as Promise<unknown>,
          staleTime: staleTimes.dashboard,
        });
        break;
      case "/recent":
        qc.prefetchQuery({
          queryKey: queryKeys.rssFeedFlat(undefined, 100, null, false),
          queryFn: () => Reader.getRssFlatPage(1, 100, {}),
          staleTime: staleTimes.rss,
        });
        break;
      case "/whitelist":
        qc.prefetchQuery({
          queryKey: queryKeys.whitelist(false),
          queryFn: () =>
            Reader.getWhitelist(1, 1000, false) as Promise<unknown>,
          staleTime: staleTimes.whitelist,
        });
        break;
      case "/dispatch-history":
        qc.prefetchQuery({
          queryKey: queryKeys.dispatchHistory(),
          queryFn: () => Reader.getDispatchHistory(1, 1000) as Promise<unknown>,
          staleTime: staleTimes.dispatch,
        });
        break;
      case "/exclude-list":
        qc.prefetchQuery({
          queryKey: queryKeys.excludedTitles,
          queryFn: () => Reader.getExcludedTitles() as Promise<unknown>,
          staleTime: staleTimes.excluded,
        });
        break;
    }
  };
}
