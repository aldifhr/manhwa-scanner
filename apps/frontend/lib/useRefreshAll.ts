"use client";
import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";
import { useToast } from "./useToast";

export function useRefreshAll() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["rss-feed-flat"] }),
        queryClient.refetchQueries({ queryKey: queryKeys.whitelist }),
        queryClient.refetchQueries({ queryKey: queryKeys.dispatchHistory() }),
        queryClient.refetchQueries({ queryKey: queryKeys.dashboardSnapshot }),
        queryClient.refetchQueries({ queryKey: queryKeys.excludedTitles }),
        queryClient.refetchQueries({ queryKey: queryKeys.stats }),
      ]);
      toast("Refreshed — all data reloaded", "success");
    } catch {
      toast("Refresh failed", "error");
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, toast]);

  return { handleRefresh, refreshing };
}
