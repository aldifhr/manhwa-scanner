"use client";

import { getOriginFlag } from "@/lib/constants";
import { filterButtonClass } from "@/lib/styles";
import { WarningCircle } from "@phosphor-icons/react";

interface Props {
  sources: string[];
  countryCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  unknownCount: number;
  countryFilter: string | null;
  sourceFilter: string | null;
  typeFilter: string | null;
  setCountryFilter: (v: string | null) => void;
  setSourceFilter: (v: string | null) => void;
  setTypeFilter: (v: string | null) => void;
}

export default function AllTabFilters({
  sources,
  countryCounts,
  typeCounts,
  unknownCount,
  countryFilter,
  sourceFilter,
  typeFilter,
  setCountryFilter,
  setSourceFilter,
  setTypeFilter,
}: Props) {
  return (
    <div className="sticky top-2 z-10 bg-black/80 backdrop-blur-md -mx-1 px-1 py-2 flex flex-col gap-2">
      {/* Country filter - horizontal scroll on mobile */}
      <div className="filter-scroll flex gap-2 pb-1 -mx-1 px-1">
        <button
          onClick={() => setCountryFilter(null)}
          className={filterButtonClass(countryFilter === null)}
        >
          All Countries
        </button>
        {[
          { code: "korean", label: "Korea" },
          { code: "chinese", label: "China" },
        ].map(({ code, label }) => {
          const n = countryCounts[code] ?? 0;
          return (
            <button
              key={code}
              onClick={() =>
                setCountryFilter(countryFilter === code ? null : code)
              }
              className={`inline-flex items-center gap-1.5 whitespace-nowrap ${filterButtonClass(countryFilter === code)}`}
            >
              {getOriginFlag(code) && (
                <img
                  src={getOriginFlag(code)}
                  alt={code}
                  className="w-4 h-auto rounded-sm"
                />
              )}
              {label}
              {n > 0 && <span className="opacity-60">({n})</span>}
            </button>
          );
        })}
        {unknownCount > 0 && (
          <button
            onClick={() => setCountryFilter("__unknown__")}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap ${filterButtonClass(countryFilter === "__unknown__")}`}
          >
            <WarningCircle size={14} weight="regular" className="shrink-0" />
            Unknown
            <span className="opacity-60">({unknownCount})</span>
          </button>
        )}
      </div>

      {/* Source filter */}
      <div className="flex gap-2 flex-wrap">
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
            {s}
          </button>
        ))}
      </div>

      {/* Type filter */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setTypeFilter(null)}
          className={filterButtonClass(typeFilter === null)}
        >
          All Types
        </button>
        {[
          { id: "manhwa", label: "Manhwa" },
          { id: "manhua", label: "Manhua" },
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
      </div>
    </div>
  );
}
