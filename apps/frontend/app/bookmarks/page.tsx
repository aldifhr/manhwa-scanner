"use client";

import { PageShell } from "@/components/PageShell";
import { useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { getBookmarks, deleteBookmark, type BookmarkEntry } from "@/lib/api";
import { rewriteCoverUrl, decodeHtml } from "@/lib/utils";
import { motion } from "framer-motion";
import { useContinueReading } from "@/lib/continueReading";
import { BookOpen, BookmarkSimple } from "@phosphor-icons/react";

export default function BookmarksPage() {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const {
    data: bookmarks,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["bookmarks"],
    queryFn: getBookmarks,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { entries: continueEntries, removeReading } = useContinueReading();

  const handleDelete = async (titleKey: string, chapterNumber: number) => {
    try {
      await deleteBookmark(titleKey, chapterNumber);
      refetch();
    } catch (err) {
      console.error("Failed to delete bookmark:", err);
    }
    setDeleteConfirm(null);
  };

  const continueList = [...continueEntries.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  // Unified Reading: merge bookmarks (server) + continueReading (local) by titleKey, dedup
  const unified = useMemo(() => {
    const map = new Map<
      string,
      { type: "bookmark" | "continue"; data: any; updatedAt: number }
    >();
    for (const c of continueList) {
      map.set(c.titleKey, {
        type: "continue",
        data: c,
        updatedAt: new Date(c.updatedAt).getTime(),
      });
    }
    for (const b of bookmarks ?? []) {
      const key = b.title_key;
      const t = new Date(b.updated_at).getTime();
      const existing = map.get(key);
      if (!existing || t > existing.updatedAt) {
        map.set(key, { type: "bookmark", data: b, updatedAt: t });
      }
    }
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [bookmarks, continueList]);

  const isEmpty = !isLoading && unified.length === 0;

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen size={22} weight="fill" /> Reading
          </h1>
          <span className="text-sm text-text-muted">
            {unified.length} {unified.length === 1 ? "title" : "titles"}
          </span>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
          </div>
        ) : isEmpty ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-white/[0.02]"
          >
            <BookmarkSimple size={32} className="mx-auto text-white/30 mb-3" />
            <p className="font-medium">No reading yet</p>
            <p className="text-sm text-text-muted mt-1">
              Chapters you open or bookmark will appear here
            </p>
            <Link
              href="/recent"
              className="inline-flex items-center justify-center mt-4 px-4 py-2 text-sm font-medium rounded-lg bg-white text-black hover:bg-white/90 transition-colors"
            >
              Explore Recent
            </Link>
          </motion.div>
        ) : (
          <motion.div
            className="space-y-3"
            initial="hidden"
            animate="visible"
            variants={{
              hidden: {},
              visible: { transition: { staggerChildren: 0.05 } },
            }}
          >
            {unified.map((item) => {
              if (item.type === "bookmark") {
                const b = item.data as BookmarkEntry;
                const cover = rewriteCoverUrl(b.cover || null);
                return (
                  <motion.div
                    key={`b-${b.title_key}-${b.chapter_number}`}
                    className="bg-surface rounded-lg p-4 border border-border flex items-center gap-4"
                    variants={{
                      hidden: { opacity: 0, y: 8 },
                      visible: { opacity: 1, y: 0 },
                    }}
                    transition={{ duration: 0.25 }}
                  >
                    {cover ? (
                      <img
                        src={cover}
                        alt={decodeHtml(b.title || b.title_key)}
                        className="w-14 h-20 object-cover rounded-md bg-white/5 shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-14 h-20 rounded-md bg-white/5 shrink-0 flex items-center justify-center text-white/30 text-xs">
                        No cover
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate flex items-center gap-1.5">
                        {decodeHtml(b.title || b.title_key)}{" "}
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/20 leading-none">
                          Bookmark
                        </span>
                      </p>
                      <p className="text-sm text-text-muted">
                        Chapter {b.chapter_number} · {b.source} ·{" "}
                        {new Date(b.updated_at).toLocaleDateString()}
                      </p>
                      {b.position_pct > 0 && (
                        <div className="mt-2">
                          <div className="h-1.5 bg-surface-active rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent"
                              style={{ width: `${b.position_pct}%` }}
                            />
                          </div>
                          <p className="text-xs text-text-muted mt-1">
                            {b.position_pct.toFixed(0)}% read
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <a
                        href={b.chapter_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium leading-none rounded bg-accent/15 text-accent border border-accent/20 hover:bg-accent/25 transition-colors"
                      >
                        Read
                      </a>
                      {deleteConfirm ===
                      `${b.title_key}-${b.chapter_number}` ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() =>
                              handleDelete(b.title_key, b.chapter_number)
                            }
                            className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium leading-none rounded bg-red-500/15 text-red-400 border border-red-500/20"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium leading-none rounded bg-surface border border-border"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() =>
                            setDeleteConfirm(
                              `${b.title_key}-${b.chapter_number}`
                            )
                          }
                          className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium leading-none rounded bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              }
              const c = item.data;
              const cover = rewriteCoverUrl(c.cover || null);
              return (
                <motion.div
                  key={`c-${c.titleKey}`}
                  className="bg-surface rounded-lg p-4 border border-border flex items-center gap-4"
                  variants={{
                    hidden: { opacity: 0, y: 8 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={{ duration: 0.25 }}
                >
                  {cover ? (
                    <img
                      src={cover}
                      alt={decodeHtml(c.title)}
                      className="w-14 h-20 object-cover rounded-md bg-white/5 shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-14 h-20 rounded-md bg-white/5 shrink-0 flex items-center justify-center text-white/30 text-xs">
                      No cover
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate flex items-center gap-1.5">
                      {decodeHtml(c.title)}{" "}
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60 border border-white/10 leading-none">
                        Continue
                      </span>
                    </p>
                    <p className="text-sm text-text-muted truncate">
                      {c.lastChapter} · {c.source} ·{" "}
                      {new Date(c.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <a
                      href={c.chapterUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium leading-none rounded bg-accent/15 text-accent border border-accent/20 hover:bg-accent/25 transition-colors"
                    >
                      Read
                    </a>
                    <button
                      onClick={() => removeReading(c.titleKey)}
                      className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium leading-none rounded bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </div>
    </PageShell>
  );
}
