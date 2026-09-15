"use client";

import { filterButtonClass } from "@/lib/styles";

interface Props {
  sources: string[];
  typeCounts: Record<string, number>;
  noDescCount: number;
  sourceFilter: string | null;
  typeFilter: string | null;
  noDescription: boolean;
  setSourceFilter: (v: string | null) => void;
  setTypeFilter: (v: string | null) => void;
  setNoDescription: (v: boolean) => void;
}

export default function AllTabFilters({
  sources,
  typeCounts,
  noDescCount,
  sourceFilter,
  typeFilter,
  noDescription,
  setSourceFilter,
  setTypeFilter,
  setNoDescription,
}: Props) {
  const hasActive =
    sourceFilter !== null || typeFilter !== null || noDescription;
  return (
    <div className="sticky top-[57px] z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2.5 flex flex-col gap-2.5 bg-black/80 backdrop-blur-xl border-y border-white/8 supports-[backdrop-filter]:bg-black/40">
      {/* Row 1: Source filter */}
      <div className="relative -mx-4 sm:-mx-6 px-4 sm:px-6">
        <div
          className="filter-scroll flex gap-2 pb-1 pr-6 scrollbar-hide"
          style={{ WebkitOverflowScrolling: "touch" }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => setSourceFilter(null)}
            className={filterButtonClass(sourceFilter === null)}
          >
            All Sources
          </button>
          {sources.map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(sourceFilter === s ? null : s)}
              className={filterButtonClass(sourceFilter === s)}
            >
              <span className="capitalize">{s}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: Type filter + clear */}
      <div className="flex items-center gap-2 flex-nowrap overflow-x-auto scrollbar-hide filter-scroll py-0.5">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-white/30 shrink-0">
          Type
        </span>
        <button
          onClick={() => setTypeFilter(null)}
          className={filterButtonClass(typeFilter === null)}
        >
          All
        </button>
        {[
          { id: "manhwa", label: "Manhwa" },
          { id: "manhua", label: "Manhua" },
          { id: "manga", label: "Manga" },
          { id: "no_type", label: "No Type" },
        ].map(({ id, label }) => {
          const n = typeCounts[id] ?? 0;
          return (
            <button
              key={id}
              onClick={() => setTypeFilter(typeFilter === id ? null : id)}
              className={filterButtonClass(typeFilter === id)}
            >
              {label} {n > 0 && <span className="opacity-60">({n})</span>}
            </button>
          );
        })}
        <span className="w-px h-4 bg-white/10 mx-1 shrink-0" aria-hidden />
        <button
          onClick={() => setNoDescription(!noDescription)}
          className={filterButtonClass(noDescription)}
        >
          No Desc {noDescCount > 0 && <span className="opacity-60">({noDescCount})</span>}
        </button>
        {hasActive && (
          <button
            onClick={() => {
              setSourceFilter(null);
              setTypeFilter(null);
              setNoDescription(false);
            }}
            className="ml-auto inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-colors min-h-0 min-w-0 shrink-0 whitespace-nowrap"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
