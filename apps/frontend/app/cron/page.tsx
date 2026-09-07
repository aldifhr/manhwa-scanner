"use client";
import { PageShell } from "@/components/PageShell";
import { useQuery } from "@tanstack/react-query";
import { readerFetch } from "@/lib/reader/transport";

export default function CronPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["cron-list"],
    queryFn: async () => {
      const r = await readerFetch<{ success: boolean; data: { total: number; jobs: any[] } }>(
        "/api/v1/queue/cron"
      );
      return r.data;
    },
    refetchInterval: 10000,
  });

  const jobs = data?.jobs || [];
  const total = data?.total || 0;

  const breakdown: Record<string, number> = {};
  for (const j of jobs) {
    const action = j.action || "unknown";
    const key = action.split(":")[0];
    breakdown[key] = (breakdown[key] || 0) + 1;
  }

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Cron Jobs</h1>
          <span className="text-xs px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">
            protected
          </span>
        </div>

        {isLoading && <div className="skeleton h-24 rounded-xl" />}
        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            Error: {(error as Error).message}
          </div>
        )}

        {!isLoading && !error && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="bg-surface border border-border rounded-xl p-4">
                <p className="text-xs text-text-muted">Total jobs</p>
                <p className="text-xl font-bold">{total}</p>
              </div>
              {Object.entries(breakdown).map(([action, count]) => (
                <div key={action} className="bg-surface border border-border rounded-xl p-4">
                  <p className="text-xs text-text-muted capitalize">{action}</p>
                  <p className="text-xl font-bold">{count}</p>
                </div>
              ))}
            </div>

            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-muted">
                      <th className="px-4 py-3 font-medium">#</th>
                      <th className="px-4 py-3 font-medium">Action</th>
                      <th className="px-4 py-3 font-medium">Source</th>
                      <th className="px-4 py-3 font-medium">Title</th>
                      <th className="px-4 py-3 font-medium">Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-text-muted">
                          No jobs in queue
                        </td>
                      </tr>
                    ) : (
                      jobs.map((j: any, i: number) => (
                        <tr key={i} className="border-b border-border/50 hover:bg-white/5">
                          <td className="px-4 py-2 text-text-muted">{i + 1}</td>
                          <td className="px-4 py-2">
                            <span className={`px-2 py-0.5 rounded text-xs font-mono ${
                              j.action?.startsWith("rss-fetch") 
                                ? "bg-emerald-500/15 text-emerald-400" 
                                : j.action === "update"
                                ? "bg-blue-500/15 text-blue-400"
                                : "bg-white/10 text-white/60"
                            }`}>
                              {j.action || "—"}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-text-muted">{j.source || "—"}</td>
                          <td className="px-4 py-2 truncate max-w-xs">{j.title || "—"}</td>
                          <td className="px-4 py-2">{j.attempts > 0 ? j.attempts : "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
