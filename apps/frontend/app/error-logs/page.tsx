"use client";

import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";
import { useState } from "react";

interface ErrorLog {
  id: string;
  level: string;
  source: string;
  message: string;
  created_at: string;
}

export default function ErrorLogsPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["error-logs", page, q],
    queryFn: async () => {
      const p = new URLSearchParams({ page: String(page), page_size: "50" });
      if (q) p.set("q", q);
      const res = await readerFetch<{
        success: boolean;
        data: { results: ErrorLog[]; total: number };
      }>(`/api/v1/logs/errors?${p}`);
      return res.data;
    },
  });

  return (
    <PageShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">Error Logs</h1>
          <div className="flex items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search source/message"
              className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-white/20"
            />
            <button
              onClick={() => refetch()}
              className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white"
            >
              Refresh
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
          </div>
        ) : error ? (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">
            {(error as Error).message}
          </div>
        ) : !data || data.results.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-white/10 rounded-2xl bg-white/[0.02]">
            <p className="text-white/60 text-sm">No errors — clean!</p>
          </div>
        ) : (
          <>
            <p className="text-xs text-white/40">
              {data.total} total • page {page}
            </p>
            <div className="space-y-2">
              {data.results.map((log) => (
                <div
                  key={log.id}
                  className="bg-surface rounded-lg p-3 border border-border"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded font-bold ${log.level === "error" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"}`}
                    >
                      {log.level}
                    </span>
                    <span className="text-white/50">{log.source}</span>
                    <span className="ml-auto text-white/30">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-white/80 mt-1 break-words">
                    {log.message}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 justify-center pt-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg bg-white/5 text-white/70 disabled:opacity-30 text-sm"
              >
                Prev
              </button>
              <span className="text-xs text-white/40">Page {page}</span>
              <button
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 rounded-lg bg-white/5 text-white/70 text-sm"
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
