"use client";

import { useMemo } from "react";

interface DispatchChartProps {
  data?: { label: string; value: number }[];
}

export default function DispatchChart({ data = [] }: DispatchChartProps) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="space-y-3">
      {data.length === 0 ? (
        <p className="text-sm text-white/40">No dispatch data yet</p>
      ) : (
        <>
          <div className="text-2xl font-bold text-white">{total}</div>
          <div className="space-y-1.5">
            {data.map((d) => (
              <div key={d.label} className="flex items-center gap-3">
                <span className="text-xs text-white/60 w-20 truncate">{d.label}</span>
                <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${(d.value / max) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-white/50 w-8 text-right">{d.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
