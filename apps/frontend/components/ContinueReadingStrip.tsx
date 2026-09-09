"use client";

import { BookOpen } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Reader } from "@/lib/reader";
import { useContinueReading } from "@/lib/continueReading";
import { decodeHtml } from "@/lib/utils";

interface ContinueReadingEntry {
  titleKey: string;
  title: string;
  cover: string | null;
  source: string;
  lastChapter: string;
  chapterUrl: string;
  updatedAt: string;
}

function ContinueReadingCard({ entry }: { entry: ContinueReadingEntry }) {
  return (
    <a
      href={entry.chapterUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group shrink-0 w-36 sm:w-44 relative"
    >
      <div className="relative overflow-hidden rounded-xl border border-white/8 hover:border-white/15 bg-surface">
        {entry.cover ? (
          <img
            src={entry.cover}
            alt={decodeHtml(entry.title)}
            className="w-full aspect-3/4 object-cover bg-surface group-hover:scale-[1.03] transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
            loading="lazy"
          />
        ) : (
          <div className="w-full aspect-3/4 rounded-xl cover-placeholder flex items-center justify-center bg-surface border border-white/6">
            <BookOpen size={24} className="text-white/30" />
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black via-black/70 to-transparent pt-6 p-2.5">
          <p className="text-[11px] font-bold tracking-wide text-white">
            Ch. {entry.lastChapter}
          </p>
        </div>
      </div>
      <div className="mt-2.5 px-1">
        <h3 className="text-xs sm:text-[13px] font-semibold leading-snug text-white line-clamp-2 min-h-[2.2rem] group-hover:text-white/80 transition-colors">
          {decodeHtml(entry.title)}
        </h3>
        <p className="text-[10px] text-white/45 mt-1 tracking-wide">
          {entry.source}
        </p>
      </div>
    </a>
  );
}

export default function ContinueReadingStrip() {
  const { entries, clearAll } = useContinueReading();
  const { data: unreadCount = 0 } = useQuery({
    queryKey: ["continueReadingUnreadCount"],
    queryFn: () => Reader.getContinueReadingUnreadCount(),
  });

  const sortedEntries = [...entries.values()]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10);

  if (sortedEntries.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg sm:text-xl font-bold text-white">
          Continue Reading
        </h2>
        {unreadCount > 0 && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/90 text-white">
            {unreadCount}
          </span>
        )}
        <span className="text-xs text-white/50">({sortedEntries.length})</span>
        <button
          onClick={clearAll}
          className="ml-auto text-[11px] px-2.5 py-1 rounded-lg bg-white/5 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
        >
          Clear all
        </button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
        {sortedEntries.map((entry) => (
          <ContinueReadingCard key={entry.titleKey} entry={entry} />
        ))}
      </div>
    </div>
  );
}
