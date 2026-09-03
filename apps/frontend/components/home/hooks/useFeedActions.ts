"use client";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  addWhitelistEntry,
  addExcludedTitle,
  removeExcludedTitle,
} from "@/lib/api";
import { Reader } from "@/lib/reader";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/lib/useToast";
import type { FlatChapter } from "@/lib/feed";
import type { GroupedSeries } from "@/lib/groupChapters";

export function useFeedActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [optimisticWhitelist, setOptimisticWhitelist] = useState<Set<string>>(
    new Set()
  );
  const [optimisticExcluded, setOptimisticExcluded] = useState<Set<string>>(
    new Set()
  );
  const [excludingKey, setExcludingKey] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const { data: excludedData } = useQuery({
    queryKey: queryKeys.excludedTitles,
    queryFn: () =>
      Reader.getExcludedTitles() as Promise<{ titleKey: string }[]>,
  });
  useEffect(() => {
    if (excludedData)
      setOptimisticExcluded(new Set(excludedData.map((e) => e.titleKey)));
  }, [excludedData]);

  const addMutation = useMutation({
    mutationFn: async (item: FlatChapter) => {
      const optKey = `${item.titleKey}:${item.source}`;
      return {
        item,
        result: await addWhitelistEntry({
          title: item.title,
          seriesUrl: item.seriesUrl,
          source: item.source,
          title_key: item.titleKey,
          cover: item.cover,
          status: item.status,
          rating: item.rating,
          origin: item.origin,
          genres: item.genres,
          description: item.description ?? undefined,
        }),
        optKey,
      };
    },
    onMutate: (item) => setAddingKey(item.titleKey),
    onSuccess: ({ result, optKey }) => {
      if (result.status === "added")
        setOptimisticWhitelist((prev) => new Set(prev).add(optKey));
      queryClient.invalidateQueries({ queryKey: queryKeys.whitelist });
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      toast(
        result.status === "already_exists"
          ? "Already in whitelist"
          : "Added to whitelist",
        result.status === "added" ? "success" : "error"
      );
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to add", "error"),
    onSettled: () => setAddingKey(null),
  });

  const addGroupMutation = useMutation({
    mutationFn: async (series: GroupedSeries) => {
      // Use per-chapter titleKey (dedup merges dash/space/uuid) so optimistic keys match flat rows
      const chapterKeys = series.chapters.map((c: any) => `${(c.titleKey || series.titleKey)}:${c.source}`);
      const optKeys = [...new Set(chapterKeys)];
      // Group by source for backend calls (title_key per source should use that source's actual titleKey)
      const bySource = new Map<string, { titleKey: string; seriesUrl: string }>();
      for (const c of series.chapters as any[]) {
        if (!bySource.has(c.source)) bySource.set(c.source, { titleKey: c.titleKey || series.titleKey, seriesUrl: c.seriesUrl || series.seriesUrl });
      }
      const results = await Promise.all(
        [...bySource.entries()].map(([s, v]) =>
          addWhitelistEntry({
            title: series.title,
            seriesUrl: v.seriesUrl || undefined,
            source: s,
            title_key: v.titleKey,
            cover: series.cover,
            status: series.status,
            rating: series.rating,
            origin: series.origin,
            genres: series.genres,
            description: series.description ?? undefined,
          })
        )
      );
      return { results, optKeys };
    },
    onMutate: (series) => setAddingKey(series.titleKey),
    onSuccess: ({ results, optKeys }) => {
      const added = results.some((r) => r.status === "added");
      if (added)
        setOptimisticWhitelist((prev) => new Set([...prev, ...optKeys]));
      queryClient.invalidateQueries({ queryKey: queryKeys.whitelist });
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      toast(
        added ? "Added to whitelist" : "Already in whitelist",
        added ? "success" : "error"
      );
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to add", "error"),
    onSettled: () => setAddingKey(null),
  });

  const excludeMutation = useMutation({
    mutationFn: async (item: FlatChapter) => {
      const isExcl = optimisticExcluded.has(item.titleKey);
      if (isExcl) {
        await removeExcludedTitle({ title_key: item.titleKey, source: "all" });
        return { isExcl: true, titleKey: item.titleKey };
      } else {
        await addExcludedTitle({
          title_key: item.titleKey,
          title: item.title,
          source: "all",
          cover: item.cover ?? null,
          series_url: item.seriesUrl ?? null,
        });
        return { isExcl: false, titleKey: item.titleKey };
      }
    },
    onMutate: (item) => setExcludingKey(item.titleKey),
    onSuccess: ({ isExcl, titleKey }) => {
      if (isExcl) {
        setOptimisticExcluded((prev) => {
          const n = new Set(prev);
          n.delete(titleKey);
          return n;
        });
        toast("Title shown again", "success");
      } else {
        setOptimisticExcluded((prev) => new Set(prev).add(titleKey));
        toast("Excluded from feed", "success");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to exclude", "error"),
    onSettled: () => setExcludingKey(null),
  });

  const excludeSeriesMutation = useMutation({
    mutationFn: async (series: GroupedSeries) => {
      const isExcl = optimisticExcluded.has(series.titleKey);
      if (isExcl) {
        await removeExcludedTitle({
          title_key: series.titleKey,
          source: "all",
        });
        return { isExcl: true, titleKey: series.titleKey };
      } else {
        await addExcludedTitle({
          title_key: series.titleKey,
          title: series.title,
          source: "all",
          cover: series.cover ?? null,
          series_url: series.seriesUrl ?? null,
        });
        return { isExcl: false, titleKey: series.titleKey };
      }
    },
    onMutate: (series) => setExcludingKey(series.titleKey),
    onSuccess: ({ isExcl, titleKey }) => {
      if (isExcl) {
        setOptimisticExcluded((prev) => {
          const n = new Set(prev);
          n.delete(titleKey);
          return n;
        });
        toast("Title shown again", "success");
      } else {
        setOptimisticExcluded((prev) => new Set(prev).add(titleKey));
        toast("Excluded from feed", "success");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to exclude", "error"),
    onSettled: () => setExcludingKey(null),
  });

  const handleAdd = useCallback(
    (item: FlatChapter) => addMutation.mutate(item),
    [addMutation]
  );
  const handleAddGroup = useCallback(
    (series: GroupedSeries) => addGroupMutation.mutate(series),
    [addGroupMutation]
  );
  const handleExclude = useCallback(
    (item: FlatChapter) => excludeMutation.mutate(item),
    [excludeMutation]
  );
  const handleExcludeSeries = useCallback(
    (series: GroupedSeries) => excludeSeriesMutation.mutate(series),
    [excludeSeriesMutation]
  );

  return {
    optimisticWhitelist,
    optimisticExcluded,
    excludingKey,
    addingKey,
    handleAdd,
    handleAddGroup,
    handleExclude,
    handleExcludeSeries,
  } as const;
}
