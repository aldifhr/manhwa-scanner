"use client";
import { cn } from "@/lib/utils";

interface Option {
  value: string;
  label: string;
  count?: number;
}

export function SegmentedControl({
  value,
  onChange,
  options,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: (Option & { activeValue?: string | null })[];
}) {
  return (
    <div className="flex items-center rounded-lg border border-white/10 overflow-hidden text-xs">
      {options.map((opt) => {
        const activeVal =
          (opt as { activeValue?: string | null }).activeValue ?? opt.value;
        const active =
          value === activeVal || (opt.value === "All" && value === null);
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value === "All" ? null : opt.value)}
            className={cn(
              "px-2 sm:px-3 py-1.5 transition-colors whitespace-nowrap",
              active
                ? "bg-white/10 text-white"
                : "text-white/50 hover:text-white"
            )}
          >
            {opt.label}
            {typeof opt.count === "number" && opt.count > 0 && (
              <span className="opacity-60 ml-0.5 hidden sm:inline tabular-nums">
                ({opt.count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
