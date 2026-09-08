"use client";

import { useMemo, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { BookOpen, BookBookmark } from "@phosphor-icons/react";
import { useContinueReading } from "@/lib/continueReading";
import { decodeHtml } from "@/lib/utils";
import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { getBookmarks } from "@/lib/api";

function CoverImage({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return (
      <div className="w-full aspect-3/4 rounded-xl flex items-center justify-center bg-white/5 border border-white/10">
        <span className="text-white/30 text-xs tracking-wide">No cover</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-full aspect-3/4 object-cover bg-white/5 group-hover:scale-[1.03] transition-transform duration-500"
      loading="lazy"
    />
  );
}

function SourcePill({ source }: { source: string }) {
  const s = source?.toLowerCase();
  const cls =
    s === "shinigami"
      ? "bg-red-500/15 text-red-400 border-red-500/20"
      : s === "ikiru"
        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
        : s === "voratoon"
          ? "bg-orange-500/15 text-orange-400 border border-orange-500/20"
          : "bg-white/10 text-white/80 border-white/10";
  return (
    <span
      className={`text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize backdrop-blur-md border shadow-sm ${cls}`}
    >
      {source}
    </span>
  );
}

function ContinueReadingCard({
  entry,
  isBookmarked,
}: {
  entry: ReturnType<typeof useContinueReading>["entries"] extends Map<
    string,
    infer V
  >
    ? V
    : never;
  isBookmarked?: boolean;
}) {
  return (
    <div className="group shrink-0 w-36 sm:w-44 relative">
      <a
        href={entry.chapterUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <div className="relative overflow-hidden rounded-xl card-hover border border-white/10 hover:border-white/15 bg-white/5">
          <CoverImage src={entry.cover} alt={decodeHtml(entry.title)} />
          <div className="absolute inset-0 bg-linear-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
          <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
            <SourcePill source={entry.source} />
            {isBookmarked && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                <BookBookmark size={10} weight="fill" /> BM
              </span>
            )}
          </div>
          <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black via-black/70 to-transparent pt-6 p-2.5">
            <p className="text-[11px] font-bold tracking-wide text-white">
              Ch. {entry.lastChapter}
            </p>
          </div>
        </div>
      </a>

      <div className="mt-2.5 px-1">
        <h3 className="text-xs sm:text-[13px] font-semibold leading-snug text-white line-clamp-2 min-h-[2.2rem] group-hover:text-white/80 transition-colors">
          {decodeHtml(entry.title)}
        </h3>
        <p className="text-[10px] text-white/45 mt-1 tracking-wide">
          {entry.origin} • {entry.source}{" "}
          {isBookmarked && <span className="text-amber-300">• Bookmarked</span>}
        </p>
      </div>
    </div>
  );
}

export function ContinueReadingStrip() {
  const { entries, clearAll } = useContinueReading();
  const { data: bookmarks } = useQuery({
    queryKey: ["bookmarks"],
    queryFn: () => getBookmarks(),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const bookmarkSet = useMemo(() => {
    const s = new Set<string>();
    for (const b of bookmarks ?? []) {
      const k = `${b.title_key}:${b.chapter_number}`;
      s.add(k);
      s.add(b.title_key);
    }
    return s;
  }, [bookmarks]);
  const sorted = useMemo(
    () =>
      [...entries.values()]
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        .slice(0, 10),
    [entries]
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, scrollLeft: 0, moved: false });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const el = scrollerRef.current;
    if (!el) return;
    setIsDragging(true);
    dragRef.current = {
      startX: e.pageX - el.offsetLeft,
      scrollLeft: el.scrollLeft,
      moved: false,
    };
  }, []);
  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      const el = scrollerRef.current;
      if (!el) return;
      const x = e.pageX - el.offsetLeft;
      const walk = x - dragRef.current.startX;
      if (Math.abs(walk) > 5) dragRef.current.moved = true;
      el.scrollLeft = dragRef.current.scrollLeft - walk;
    },
    [isDragging]
  );
  const onMouseUp = useCallback(() => setIsDragging(false), []);
  const onMouseLeave = useCallback(() => setIsDragging(false), []);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const el = scrollerRef.current;
    if (!el) return;
    setIsDragging(true);
    dragRef.current = {
      startX: e.touches[0].pageX - el.offsetLeft,
      scrollLeft: el.scrollLeft,
      moved: false,
    };
  }, []);
  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging) return;
      const el = scrollerRef.current;
      if (!el) return;
      const x = e.touches[0].pageX - el.offsetLeft;
      const walk = x - dragRef.current.startX;
      if (Math.abs(walk) > 5) dragRef.current.moved = true;
      el.scrollLeft = dragRef.current.scrollLeft - walk;
    },
    [isDragging]
  );
  const onTouchEnd = useCallback(() => setIsDragging(false), []);

  // Prevent click on cards when drag moved
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragRef.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current.moved = false;
    }
  }, []);

  if (entries.size === 0) return null;
  return (
    <PageShell>
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-1.5 rounded-lg bg-[var(--gold-accent-soft)] border border-[var(--gold-border)]">
            <BookBookmark
              size={16}
              className="text-[var(--gold-accent)]"
              weight="fill"
            />
          </div>
          <h2
            className="text-lg sm:text-[19px] font-bold tracking-[-0.03em] text-white"
            style={{ fontFamily: '"Space Grotesk", var(--font-sans)' }}
          >
            Bookmark
          </h2>
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/50 tabular-nums">
            ({entries.size})
          </span>
          <button
            onClick={clearAll}
            className="ml-auto text-[11px] px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 hover:border-white/15 transition-colors"
          >
            Clear all
          </button>
        </div>
        <div
          ref={scrollerRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onClickCapture={onClickCapture}
          className={`flex gap-3 overflow-x-auto pb-3 pt-1 -mx-1 px-1 scrollbar-hide snap-x snap-mandatory select-none [mask-image:linear-gradient(to_right,black_92%,transparent)] ${isDragging ? "cursor-grabbing" : "cursor-grab active:cursor-grabbing"}`}
          style={{ scrollbarWidth: "none" } as React.CSSProperties}
        >
          {sorted.map((entry, i) => {
            const isBM =
              bookmarkSet.has(`${entry.titleKey}:${entry.lastChapter}`) ||
              bookmarkSet.has(entry.titleKey);
            return (
              <motion.div
                key={entry.titleKey}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.25 }}
                className={isDragging ? "pointer-events-none" : ""}
              >
                <ContinueReadingCard entry={entry} isBookmarked={isBM} />
              </motion.div>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
