"use client";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/lib/useToast";
import { usePacerRateLimitedWL } from "@/lib/usePacerThrottles";
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
  const [optimisticCompleted, setOptimisticCompleted] = useState<Set<string>>(
    new Set()
  );
  const [excludingKey, setExcludingKey] = useState<string | null>(null);
  const [completingKey, setCompletingKey] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const isLoggedIn =
    typeof document !== "undefined" &&
    !!document.cookie.match(/(?:^|;\s*)ikiru_csrf_token=/);
  const { data: excludedData } = useQuery({
    queryKey: queryKeys.excludedTitles,
    queryFn: () =>
      Reader.getExcludedTitles() as Promise<
        { titleKey: string; source?: string; reason?: string; isCompleted?: boolean }[]
      >,
    enabled: isLoggedIn,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (excludedData) {
      setOptimisticExcluded(
        new Set(
          excludedData.map(
            (e) => `${e.titleKey}:${(e.source || "all").toLowerCase()}`
          )
        )
      );
      setOptimisticCompleted(
        new Set(
          excludedData
            .filter((e) => e.reason === "completed" || (e as any).isCompleted || (e as any).is_completed)
            .map((e) => `${e.titleKey}:${(e.source || "all").toLowerCase()}`)
        )
      );
    }
  }, [excludedData]);

  const addMutation = useMutation({
    mutationFn: async (item: FlatChapter) => {
      const optKey = `${item.titleKey}:${item.source}`;
      return {
        item,
        result: (await Reader.addWhitelistEntry({
          title: item.title,
          seriesUrl: item.seriesUrl,
          source: item.source,
          title_key: item.titleKey,
          cover: item.cover,
          rating: item.rating,
          origin: item.origin,
          genres: item.genres,
          description: item.description ?? undefined,
        } as Record<string, unknown>)) as {
          status: "added" | "already_exists";
        },
        optKey,
      };
    },
    onMutate: (item) => setAddingKey(item.titleKey),
    onSuccess: ({ result, optKey, item }) => {
      // already_exists should also become optimistic Added (bandel fix for Full-time Hunter UUID vs slug)
      setOptimisticWhitelist((prev) => new Set(prev).add(optKey));
      queryClient.invalidateQueries({ queryKey: queryKeys.whitelistAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      const isExists = result.status === "already_exists";
      toast(
        isExists ? "Already in whitelist" : `Added ${item.title} to whitelist`,
        {
          type: "success",
          duration: 5000,
          action: isExists
            ? undefined
            : {
                label: "Undo",
                onClick: () => {
                  setOptimisticWhitelist((prev) => {
                    const n = new Set(prev);
                    n.delete(optKey);
                    return n;
                  });
                  const [tk, src] = optKey.split(":");
                  if (tk && src)
                    Reader.removeWhitelistEntry({
                      title_key: tk,
                      source: src,
                    } as Record<string, unknown>).catch(() => {});
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.whitelistAll,
                  });
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.homeFeed,
                  });
                },
              },
        }
      );
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to add", "error"),
    onSettled: () => setAddingKey(null),
  });

  const addGroupMutation = useMutation({
    mutationFn: async (series: GroupedSeries) => {
      // Use per-chapter titleKey (dedup merges dash/space/uuid) so optimistic keys match flat rows
      const chapterKeys = series.chapters.map(
        (c: any) => `${c.titleKey || series.titleKey}:${c.source}`
      );
      const optKeys = [...new Set(chapterKeys)];
      // Group by source for backend calls (title_key per source should use that source's actual titleKey)
      const bySource = new Map<
        string,
        { titleKey: string; seriesUrl: string }
      >();
      for (const c of series.chapters as any[]) {
        if (!bySource.has(c.source))
          bySource.set(c.source, {
            titleKey: c.titleKey || series.titleKey,
            seriesUrl: c.seriesUrl || series.seriesUrl,
          });
      }
      const results = await Promise.all(
        [...bySource.entries()].map(([s, v]) =>
          Reader.addWhitelistEntry({
            title: series.title,
            seriesUrl: v.seriesUrl || undefined,
            source: s,
            title_key: v.titleKey,
            cover: series.cover,
            rating: series.rating,
            origin: series.origin,
            genres: series.genres,
            description: series.description ?? undefined,
          } as Record<string, unknown>)
        )
      );
      return { results, optKeys };
    },
    onMutate: (series) => setAddingKey(series.titleKey),
    onSuccess: ({ results, optKeys }, series) => {
      // Bandel fix: already_exists also counts as added for optimistic
      setOptimisticWhitelist((prev) => new Set([...prev, ...optKeys]));
      queryClient.invalidateQueries({ queryKey: queryKeys.whitelistAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      toast(`Added ${series.title} to whitelist`, {
        type: "success",
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => {
            // rollback optimistic + BE delete per source
            setOptimisticWhitelist((prev) => {
              const n = new Set(prev);
              for (const k of optKeys) n.delete(k);
              return n;
            });
            // fire delete per source (best-effort)
            const bySource = new Map<string, string>();
            for (const k of optKeys) {
              const [tk, src] = k.split(":");
              if (src && !bySource.has(src)) bySource.set(src, tk);
            }
            for (const [src, tk] of bySource) {
              Reader.removeWhitelistEntry({
                title_key: tk,
                source: src,
              } as Record<string, unknown>).catch(() => {});
            }
            queryClient.invalidateQueries({ queryKey: queryKeys.whitelistAll });
            queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
          },
        },
      });
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to add", "error"),
    onSettled: () => setAddingKey(null),
  });

  const excludeMutation = useMutation({
    mutationFn: async (item: FlatChapter) => {
      const src = (item.source || "all").toLowerCase();
      const key = `${item.titleKey}:${src}`;
      const legacyKey = `${item.titleKey}:all`;
      const isExcl = optimisticExcluded.has(key) || optimisticExcluded.has(legacyKey);
      if (isExcl) {
        // Prefer deleting the specific source if present, else legacy "all"
        const srcToDelete = optimisticExcluded.has(key) && !optimisticExcluded.has(legacyKey) ? src : optimisticExcluded.has(legacyKey) ? "all" : src;
        await Reader.removeExcludedTitle({
          title_key: item.titleKey,
          source: srcToDelete,
        } as Record<string, unknown>);
        // If both keys exist (edge: duplicate all+specific), clean up the other as well
        if (optimisticExcluded.has(key) && optimisticExcluded.has(legacyKey) && srcToDelete !== "all") {
          try {
            await Reader.removeExcludedTitle({
              title_key: item.titleKey,
              source: "all",
            } as Record<string, unknown>);
          } catch {}
        }
        return { isExcl: true, key, legacyKey, srcToDelete };
      } else {
        await Reader.addExcludedTitle({
          title_key: item.titleKey,
          title: item.title,
          source: src,
          cover: item.cover ?? null,
          series_url: item.seriesUrl ?? null,
        } as Record<string, unknown>);
        return { isExcl: false, key };
      }
    },
    onMutate: (item) => setExcludingKey(item.titleKey),
    onSuccess: ({ isExcl, key, legacyKey }) => {
      if (isExcl) {
        setOptimisticExcluded((prev) => {
          const n = new Set(prev);
          n.delete(key);
          if (legacyKey) n.delete(legacyKey);
          return n;
        });
        toast("Title shown again", "success");
      } else {
        setOptimisticExcluded((prev) => new Set(prev).add(key));
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
      // Per-source: one row per distinct source in the grouped series
      const bySource = new Map<string, { titleKey: string; seriesUrl: string }>();
      for (const c of series.chapters as unknown as { titleKey: string; source: string; seriesUrl: string }[]) {
        if (!c.source) continue;
        const s = c.source.toLowerCase();
        if (!bySource.has(s)) bySource.set(s, { titleKey: c.titleKey || series.titleKey, seriesUrl: c.seriesUrl || series.seriesUrl });
      }
      // Fallback if chapters have no source (should not happen)
      if (bySource.size === 0 && series.titleKey) {
        bySource.set("all", { titleKey: series.titleKey, seriesUrl: series.seriesUrl });
      }
      const distinctKeys = [...bySource.entries()].map(([s, v]) => `${v.titleKey}:${s}`);
      const isExcl = distinctKeys.length > 0 && distinctKeys.every((k) => optimisticExcluded.has(k) || optimisticExcluded.has(`${k.split(":")[0]}:all`));
      if (isExcl) {
        await Promise.all(
          [...bySource.entries()].map(([s, v]) => {
            const k = `${v.titleKey}:${s}`;
            const srcToDelete = optimisticExcluded.has(k) && !optimisticExcluded.has(`${v.titleKey}:all`) ? s : optimisticExcluded.has(`${v.titleKey}:all`) ? "all" : s;
            return Reader.removeExcludedTitle({ title_key: v.titleKey, source: srcToDelete } as Record<string, unknown>);
          })
        );
        return { isExcl: true, keys: distinctKeys };
      } else {
        await Promise.all(
          [...bySource.entries()].map(([s, v]) =>
            Reader.addExcludedTitle({
              title_key: v.titleKey,
              title: series.title,
              source: s,
              cover: series.cover ?? null,
              series_url: v.seriesUrl ?? null,
            } as Record<string, unknown>)
          )
        );
        return { isExcl: false, keys: distinctKeys };
      }
    },
    onMutate: (series) => setExcludingKey(series.titleKey),
    onSuccess: ({ isExcl, keys }) => {
      if (isExcl) {
        setOptimisticExcluded((prev) => {
          const n = new Set(prev);
          for (const k of keys) {
            n.delete(k);
            n.delete(`${k.split(":")[0]}:all`);
          }
          return n;
        });
        toast("Title shown again", "success");
      } else {
        setOptimisticExcluded((prev) => new Set([...prev, ...keys]));
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

  // Completed = tamat + exclude from RSS — ponytail: reuse excluded_titles with reason=completed
  const completeMutation = useMutation({
    mutationFn: async (item: FlatChapter) => {
      const src = (item.source || "all").toLowerCase();
      const key = `${item.titleKey}:${src}`;
      const legacyKey = `${item.titleKey}:all`;
      const isComp = optimisticCompleted.has(key) || optimisticCompleted.has(legacyKey) || optimisticCompleted.has(item.titleKey);
      if (isComp) {
        const srcToDelete = optimisticCompleted.has(key) && !optimisticCompleted.has(legacyKey) ? src : optimisticCompleted.has(legacyKey) ? "all" : src;
        await Reader.removeExcludedTitle({ title_key: item.titleKey, source: srcToDelete } as Record<string, unknown>);
        if (optimisticCompleted.has(key) && optimisticCompleted.has(legacyKey) && srcToDelete !== "all") {
          try { await Reader.removeExcludedTitle({ title_key: item.titleKey, source: "all" } as Record<string, unknown>); } catch {}
        }
        return { isComp: true, key, legacyKey };
      } else {
        await Reader.markTamat({ title_key: item.titleKey, title: item.title, source: src, cover: item.cover ?? null, series_url: item.seriesUrl ?? null } as Record<string, unknown>);
        return { isComp: false, key };
      }
    },
    onMutate: (item) => setCompletingKey(item.titleKey),
    onSuccess: ({ isComp, key, legacyKey }) => {
      if (isComp) {
        setOptimisticCompleted((prev) => { const n = new Set(prev); n.delete(key); if (legacyKey) n.delete(legacyKey); return n; });
        setOptimisticExcluded((prev) => { const n = new Set(prev); n.delete(key); if (legacyKey) n.delete(legacyKey); return n; });
        toast("Completed undone", "success");
      } else {
        setOptimisticCompleted((prev) => new Set(prev).add(key));
        setOptimisticExcluded((prev) => new Set(prev).add(key));
        toast("Marked as completed & excluded from RSS", "success");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Failed to mark as completed", "error"),
    onSettled: () => setCompletingKey(null),
  });

  const completeSeriesMutation = useMutation({
    mutationFn: async (series: GroupedSeries) => {
      const bySource = new Map<string, { titleKey: string; seriesUrl: string }>();
      for (const c of series.chapters as unknown as { titleKey: string; source: string; seriesUrl: string }[]) {
        if (!c.source) continue;
        const s = c.source.toLowerCase();
        if (!bySource.has(s)) bySource.set(s, { titleKey: c.titleKey || series.titleKey, seriesUrl: c.seriesUrl || series.seriesUrl });
      }
      if (bySource.size === 0 && series.titleKey) bySource.set("all", { titleKey: series.titleKey, seriesUrl: series.seriesUrl });
      const distinctKeys = [...bySource.entries()].map(([s, v]) => `${v.titleKey}:${s}`);
      const isComp = distinctKeys.length > 0 && distinctKeys.every((k) => optimisticCompleted.has(k) || optimisticCompleted.has(`${k.split(":")[0]}:all`) || optimisticCompleted.has(k.split(":")[0]));
      if (isComp) {
        await Promise.all([...bySource.entries()].map(([s, v]) => {
          const k = `${v.titleKey}:${s}`;
          const srcToDelete = optimisticCompleted.has(k) && !optimisticCompleted.has(`${v.titleKey}:all`) ? s : optimisticCompleted.has(`${v.titleKey}:all`) ? "all" : s;
          return Reader.removeExcludedTitle({ title_key: v.titleKey, source: srcToDelete } as Record<string, unknown>);
        }));
        return { isComp: true, keys: distinctKeys };
      } else {
        await Promise.all([...bySource.entries()].map(([s, v]) => Reader.markTamat({ title_key: v.titleKey, title: series.title, source: s, cover: series.cover ?? null, series_url: v.seriesUrl ?? null } as Record<string, unknown>)));
        return { isComp: false, keys: distinctKeys };
      }
    },
    onMutate: (series) => setCompletingKey(series.titleKey),
    onSuccess: ({ isComp, keys }) => {
      if (isComp) {
        setOptimisticCompleted((prev) => { const n = new Set(prev); for (const k of keys) { n.delete(k); n.delete(`${k.split(":")[0]}:all`); n.delete(k.split(":")[0]); } return n; });
        setOptimisticExcluded((prev) => { const n = new Set(prev); for (const k of keys) { n.delete(k); n.delete(`${k.split(":")[0]}:all`); } return n; });
        toast("Completed undone", "success");
      } else {
        setOptimisticCompleted((prev) => new Set([...prev, ...keys]));
        setOptimisticExcluded((prev) => new Set([...prev, ...keys]));
        toast("Marked as completed & excluded from RSS", "success");
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
    },
    onError: (err) => toast(err instanceof Error ? err.message : "Failed to mark as completed", "error"),
    onSettled: () => setCompletingKey(null),
  });

  const rateLimitedAdd = usePacerRateLimitedWL((item: FlatChapter) =>
    addMutation.mutate(item)
  );
  const rateLimitedAddGroup = usePacerRateLimitedWL((series: GroupedSeries) =>
    addGroupMutation.mutate(series)
  );
  const handleAdd = useCallback(
    (item: FlatChapter) => rateLimitedAdd(item),
    [rateLimitedAdd]
  );
  const handleAddGroup = useCallback(
    (series: GroupedSeries) => rateLimitedAddGroup(series),
    [rateLimitedAddGroup]
  );
  const handleExclude = useCallback(
    (item: FlatChapter) => excludeMutation.mutate(item),
    [excludeMutation]
  );
  const handleExcludeSeries = useCallback(
    (series: GroupedSeries) => excludeSeriesMutation.mutate(series),
    [excludeSeriesMutation]
  );
  const handleComplete = useCallback(
    (item: FlatChapter) => completeMutation.mutate(item),
    [completeMutation]
  );
  const handleCompleteSeries = useCallback(
    (series: GroupedSeries) => completeSeriesMutation.mutate(series),
    [completeSeriesMutation]
  );

  return {
    optimisticWhitelist,
    optimisticExcluded,
    optimisticCompleted,
    excludingKey,
    completingKey,
    addingKey,
    handleAdd,
    handleAddGroup,
    handleExclude,
    handleExcludeSeries,
    handleComplete,
    handleCompleteSeries,
  } as const;
}
