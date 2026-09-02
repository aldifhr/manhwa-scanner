"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import {
  decodeHtml,
  getChapterLabel,
  rewriteCoverUrl,
  safeUrl,
} from "@/lib/utils";
import type { DispatchHistoryItem } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { useDebounced } from "@/lib/useDebounced";
import { SourceBadge } from "@/components/ui/SourceBadge";
import { getOriginFlag } from "@/lib/constants";
import {
  ClockCounterClockwise,
  MagnifyingGlass,
  LinkSimple,
} from "@phosphor-icons/react";
import { PageShell } from "@/components/PageShell";

function Row({ item }: { item: DispatchHistoryItem }) {
  const cover = item.cover ? rewriteCoverUrl(item.cover) : null;
  const chapterHref = safeUrl(item.url) ?? safeUrl(item.seriesUrl);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-hover hover:bg-surface-active transition-colors">
      {/* Cover */}
      <div className="w-9 h-12 shrink-0 rounded-md overflow-hidden bg-surface border border-border">
        {cover ? (
          <img
            src={cover}
            alt={decodeHtml(item.title)}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-muted text-xs font-bold">
            {decodeHtml(item.title).charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Title + chapter */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text truncate">
            {decodeHtml(item.title)}
          </span>
          {item.origin && getOriginFlag(item.origin) && (
            <img
              src={getOriginFlag(item.origin)}
              alt={item.origin}
              referrerPolicy="no-referrer"
              loading="lazy"
              className="w-4 h-auto shrink-0"
            />
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5">
          <span className="font-medium text-accent">
            Ch. {getChapterLabel(item)}
          </span>
          <SourceBadge source={item.source} />
          <span>·</span>
          <span>{timeAgo(item.sentAt)}</span>
        </div>
      </div>

      {/* Open */}
      {chapterHref && (
        <a
          href={chapterHref}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 p-2 rounded-md text-text-muted hover:text-accent hover:bg-surface transition-colors"
          aria-label="Open chapter"
          title="Open chapter"
        >
          <LinkSimple size={16} />
        </a>
      )}
    </div>
  );
}

export default function DispatchHistoryClient() {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<
    "all" | "ikiru" | "shinigami" | "voratoon"
  >("all");
  const debouncedSearch = useDebounced(search, 300);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.dispatchHistory(debouncedSearch || undefined),
    // Server-side search + bounded page size: fetching 10k rows per keystroke
    // was the old behavior. The backend supports `search` filtering, so a
    // 500-row page covers the on-screen list; the full 10k walk only runs
    // when no search is active (the page's "all history" list).
    queryFn: () =>
      Reader.getDispatchHistory(
        1,
        debouncedSearch ? 500 : 10000,
        debouncedSearch || ""
      ) as Promise<DispatchHistoryItem[]>,
  });

  const items = data ?? [];

  const filtered = useMemo(() => {
    if (source === "all") return items;
    return items.filter((i) => i.source === source);
  }, [items, source]);

  return (
    <PageShell>
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <ClockCounterClockwise
            size={22}
            className="text-accent"
            weight="bold"
          />
          <h1 className="text-xl font-semibold tracking-tight">
            Dispatch History
          </h1>
        </div>
        <span className="text-xs px-2 py-1 rounded-full bg-surface text-text-muted">
          {filtered.length} sent
        </span>
      </div>
      <p className="text-xs text-text-muted mb-4">
        Every chapter delivery — authoritative history (not the 24h feed).
      </p>

      {/* Search + filter */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <MagnifyingGlass
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search title..."
            aria-label="Search dispatch history"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface border border-border text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "ikiru", "shinigami", "voratoon"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={[
                "px-2.5 py-1.5 text-xs rounded-lg border transition-colors",
                source === s
                  ? "bg-accent-dim border-accent/30 text-accent"
                  : "bg-surface border-border text-text-secondary hover:text-text",
              ].join(" ")}
            >
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>
        <button
          onClick={() => refetch()}
          className="ml-auto px-2.5 py-1.5 text-xs rounded-lg bg-surface border border-border text-text-secondary hover:text-text transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton h-14 rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-col gap-2">
          <div className="text-sm text-danger bg-danger-dim border border-danger/30 rounded-xl p-4">
            Failed to load dispatch history
          </div>
          <button
            onClick={() => refetch()}
            className="text-xs px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 self-start transition-colors"
          >
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-center text-text-muted">
          <ClockCounterClockwise size={32} />
          <span className="text-sm">No chapters sent yet</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((item) => (
            <Row
              key={`${item.titleKey}-${item.chapterLabel || item.chapter}-${item.source}-${item.sentAt}`}
              item={item}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
