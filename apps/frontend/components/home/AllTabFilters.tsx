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
  const hasActive =
    countryFilter !== null || sourceFilter !== null || typeFilter !== null;
  return (
    <div className="sticky top-[57px] z-10 -mx-1 px-1 py-2 flex flex-col gap-2.5 bg-[var(--gold-bg)]/80 backdrop-blur-xl border-y border-[var(--gold-border)] supports-[backdrop-filter]:bg-black/40">
      {/* Row 1: Country + Source + clear — single scroll with fade */}
      <div className="relative -mx-1 px-1">
        <div className="filter-scroll flex gap-2 pb-0.5 pr-6 -mx-1 px-1 [mask-image:linear-gradient(to_right,black_85%,transparent)]">
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
          <span
            className="mx-1 h-4 w-px bg-white/10 shrink-0 self-center hidden sm:block"
            aria-hidden
          />
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

      {/* Row 2: Type filter + clear — compact */}
      <div className="flex items-center gap-2 flex-wrap">
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
        {hasActive && (
          <button
            onClick={() => {
              setCountryFilter(null);
              setSourceFilter(null);
              setTypeFilter(null);
            }}
            className="ml-auto inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
