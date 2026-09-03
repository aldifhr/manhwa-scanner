"use client";

import { PageShell } from "@/components/PageShell";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getBookmarks, deleteBookmark, type BookmarkEntry } from "@/lib/api";
import { rewriteCoverUrl, decodeHtml } from "@/lib/utils";
import { motion } from "framer-motion";
import { useContinueReading } from "@/lib/continueReading";

export default function BookmarksPage() {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [tab, setTab] = useState<"bookmarks" | "continue">("bookmarks");

  const {
    data: bookmarks,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["bookmarks"],
    queryFn: getBookmarks,
    enabled: tab === "bookmarks",
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

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Reading</h1>
          <span className="text-sm text-text-muted">
            {tab === "bookmarks"
              ? `${bookmarks?.length || 0} bookmarks`
              : `${continueList.length} continue`}
          </span>
        </div>

        {/* Tab switch — merges Bookmarks + Continue Reading */}
        <div className="flex gap-2 p-1 bg-surface rounded-lg border border-border w-fit">
          <button
            onClick={() => setTab("bookmarks")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === "bookmarks" ? "bg-white text-black" : "text-text-muted hover:text-text"}`}
          >
            Bookmarks
          </button>
          <button
            onClick={() => setTab("continue")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${tab === "continue" ? "bg-white text-black" : "text-text-muted hover:text-text"}`}
          >
            Continue Reading
          </button>
        </div>

        {tab === "bookmarks" ? (
          isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
            </div>
          ) : bookmarks && bookmarks.length > 0 ? (
            <motion.div className="space-y-3" initial="hidden" animate="visible" variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.05 } } }}>
              {bookmarks.map((b) => {
                const cover = rewriteCoverUrl(b.cover || null);
                return (
                <motion.div
                  key={`${b.title_key}-${b.chapter_number}`}
                  className="bg-surface rounded-lg p-4 border border-border flex items-center gap-4"
                  variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
                  transition={{ duration: 0.25 }}
                >
                  {cover ? (
                    <img src={cover} alt={decodeHtml(b.title || b.title_key)} className="w-14 h-20 object-cover rounded-md bg-white/5 shrink-0" loading="lazy" />
                  ) : (
                    <div className="w-14 h-20 rounded-md bg-white/5 shrink-0 flex items-center justify-center text-white/30 text-xs">No cover</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{decodeHtml(b.title || b.title_key)}</p>
                    <p className="text-sm text-text-muted">
                      Chapter {b.chapter_number} • {b.source} •{" "}
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
                    {deleteConfirm === `${b.title_key}-${b.chapter_number}` ? (
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
                          setDeleteConfirm(`${b.title_key}-${b.chapter_number}`)
                        }
                        className="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium leading-none rounded bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </motion.div>
              )})}
            </motion.div>
          ) : (
            <div className="text-center py-12 text-text-muted">
              <p>No bookmarks yet</p>
              <p className="text-sm mt-1">
                Save your reading position to see it here
              </p>
            </div>
          )
        ) : continueList.length > 0 ? (
          <motion.div className="space-y-3" initial="hidden" animate="visible" variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.05 } } }}>
            {continueList.map((c) => (
              <motion.div
                key={c.titleKey}
                className="bg-surface rounded-lg p-4 border border-border flex items-center justify-between"
                variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
                transition={{ duration: 0.25 }}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{c.title}</p>
                  <p className="text-sm text-text-muted truncate">
                    {c.lastChapter} • {c.source} • {c.titleKey}
                  </p>
                  <p className="text-xs text-text-muted">
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
            ))}
          </motion.div>
        ) : (
          <div className="text-center py-12 text-text-muted">
            <p>No continue reading yet</p>
            <p className="text-sm mt-1">Chapters you open will appear here</p>
          </div>
        )}
      </div>
    </PageShell>
  );
}
