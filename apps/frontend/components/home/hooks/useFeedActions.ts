"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import { queryKeys, staleTimes, gcTimes } from "@/lib/queryKeys";
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

  // refs to avoid stale closure race in mutationFn
  const excludedRef = useRef(optimisticExcluded);
  useEffect(() => { excludedRef.current = optimisticExcluded; }, [optimisticExcluded]);

  // per-key lock via Set (prevents concurrent toggle race on same title)
  const pendingKeys = useRef<Set<string>>(new Set());

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  useEffect(() => {
    const check = () => setIsLoggedIn(typeof document !== "undefined" && !!document.cookie.match(/(?:^|;\s*)ikiru_csrf_token=/));
    check();
    const id = setInterval(check, 2000);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, []);
  const { data: excludedData } = useQuery({
    queryKey: queryKeys.excludedTitles,
    queryFn: () =>
      Reader.getExcludedTitles() as Promise<
        { titleKey: string; source?: string }[]
      >,
    enabled: isLoggedIn,
    staleTime: staleTimes.excluded,
    gcTime: gcTimes.excluded,
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
    }
  }, [excludedData]);

  const addMutation = useMutation({
    mutationFn: async (item: FlatChapter) => {
      const optKey = `${item.titleKey}:${item.source}`;
      // Pre-check via React Query cache (A: jangan langsung API tiap call) — reuse stale 2m cache
      try {
        const fresh = (await queryClient.fetchQuery({
          queryKey: queryKeys.whitelist(false),
          queryFn: () => Reader.getWhitelist(1, 1000, false) as Promise<unknown>,
          staleTime: staleTimes.whitelist,
          gcTime: gcTimes.whitelist,
        })) as unknown as Array<{ titleKey?: string; source?: string }>;
        const exists = fresh.some((e) => `${e.titleKey}:${e.source}` === optKey);
        if (exists) {
          return { item, result: { status: "already_exists" as const }, optKey };
        }
      } catch {
        // If refetch fails, proceed with add attempt (BE upsert handles it)
      }
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
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat-infinite"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.rssFeedInfinite() });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSnapshot });
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
      const chapterKeys = series.chapters.map(
        (c: any) => `${c.titleKey || series.titleKey}:${c.source}`
      );
      const optKeys = [...new Set(chapterKeys)];
      // Pre-check via cache (A) — bulk whitelist fetched once & shared
      try {
        const fresh = (await queryClient.fetchQuery({
          queryKey: queryKeys.whitelist(false),
          queryFn: () => Reader.getWhitelist(1, 1000, false) as Promise<unknown>,
          staleTime: staleTimes.whitelist,
          gcTime: gcTimes.whitelist,
        })) as unknown as Array<{ titleKey?: string; source?: string }>;
        const freshKeys = new Set(fresh.map((e) => `${e.titleKey}:${e.source}`));
        const alreadyPresent = optKeys.filter((k) => freshKeys.has(k));
        const missing = optKeys.filter((k) => !freshKeys.has(k));
        // If all already exist, short-circuit
        if (missing.length === 0) {
          return { results: alreadyPresent.map(() => ({ status: "already_exists" as const })), optKeys, skipped: true };
        }
        // Build bySource only for missing keys
        const bySource = new Map<string, { titleKey: string; seriesUrl: string }>();
        for (const k of missing) {
          const src = k.split(":")[1];
          const tk = k.split(":")[0];
          if (!bySource.has(src)) {
            const chapter = series.chapters.find((c: any) => (c.titleKey || series.titleKey) === tk && c.source === src) as any;
            bySource.set(src, { titleKey: tk, seriesUrl: (chapter?.seriesUrl) || series.seriesUrl });
          }
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
        // Combine with already-existing
        const allResults = [
          ...alreadyPresent.map(() => ({ status: "already_exists" as const })),
          ...results,
        ];
        return { results: allResults, optKeys, skipped: false };
      } catch {
        // If refetch fails, proceed with original behavior
      }
      // Fallback: original behavior
      const bySource = new Map<string, { titleKey: string; seriesUrl: string }>();
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
      return { results, optKeys, skipped: false };
    },
    onMutate: (series) => setAddingKey(series.titleKey),
    onSuccess: ({ results, optKeys }, series) => {
      setOptimisticWhitelist((prev) => new Set([...prev, ...optKeys]));
      queryClient.invalidateQueries({ queryKey: queryKeys.whitelistAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.homeFeed });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat"] });
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat-infinite"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.rssFeedInfinite() });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSnapshot });
      const allExist = results.every((r) => r.status === "already_exists");
      toast(allExist ? "Already in whitelist" : `Added ${series.title} to whitelist`, {
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
      const excl = excludedRef.current;
      if (pendingKeys.current.has(key)) throw new Error("Duplicate request");
      pendingKeys.current.add(key);
      const isExcl = excl.has(key) || excl.has(legacyKey);
      if (isExcl) {
        // Prefer deleting the specific source if present, else legacy "all"
        const srcToDelete = excl.has(key) && !excl.has(legacyKey) ? src : excl.has(legacyKey) ? "all" : src;
        await Reader.removeExcludedTitle({
          title_key: item.titleKey,
          source: srcToDelete,
        } as Record<string, unknown>);
        // If both keys exist (edge: duplicate all+specific), clean up the other as well
        if (excl.has(key) && excl.has(legacyKey)) {
          try {
            await Reader.removeExcludedTitle({
              title_key: item.titleKey,
              source: srcToDelete === "all" ? src : "all",
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
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat-infinite"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.rssFeedInfinite() });
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to exclude", "error"),
    onSettled: (_data, _err, vars) => {
      setExcludingKey(null);
      if (vars) {
        const k = `${vars.titleKey}:${(vars.source || "all").toLowerCase()}`;
        pendingKeys.current.delete(k);
      }
    },
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
      for (const k of distinctKeys) if (pendingKeys.current.has(k)) throw new Error("Duplicate request");
      for (const k of distinctKeys) pendingKeys.current.add(k);
      const excl = excludedRef.current;
      const isExcl = distinctKeys.length > 0 && distinctKeys.every((k) => excl.has(k) || excl.has(`${k.split(":")[0]}:all`));
      if (isExcl) {
        for (const [s, v] of bySource) {
          const k = `${v.titleKey}:${s}`;
          const srcToDelete = excl.has(k) && !excl.has(`${v.titleKey}:all`) ? s : excl.has(`${v.titleKey}:all`) ? "all" : s;
          await Reader.removeExcludedTitle({ title_key: v.titleKey, source: srcToDelete } as Record<string, unknown>);
          if (excl.has(k) && excl.has(`${v.titleKey}:all`)) {
            try { await Reader.removeExcludedTitle({ title_key: v.titleKey, source: srcToDelete === "all" ? s : "all" } as Record<string, unknown>); } catch {}
          }
        }
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
      queryClient.invalidateQueries({ queryKey: ["rss-feed-flat-infinite"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.rssFeedInfinite() });
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedTitles });
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : "Failed to exclude", "error"),
    onSettled: (_data, _err, vars) => {
      setExcludingKey(null);
      if (vars) {
        const bySource = new Map<string, { titleKey: string; seriesUrl: string }>();
        for (const c of vars.chapters as unknown as { titleKey: string; source: string; seriesUrl: string }[]) {
          if (!c.source) continue;
          const s = c.source.toLowerCase();
          if (!bySource.has(s)) bySource.set(s, { titleKey: c.titleKey || vars.titleKey, seriesUrl: c.seriesUrl || vars.seriesUrl });
        }
        if (bySource.size === 0 && vars.titleKey) bySource.set("all", { titleKey: vars.titleKey, seriesUrl: vars.seriesUrl });
        for (const [s, v] of bySource) pendingKeys.current.delete(`${v.titleKey}:${s}`);
      }
    },
  });

  const handleAdd = useCallback((item: FlatChapter) => addMutation.mutate(item), [addMutation]);
  const handleAddGroup = useCallback((series: GroupedSeries) => addGroupMutation.mutate(series), [addGroupMutation]);
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
