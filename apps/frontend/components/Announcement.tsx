"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

export default function Announcement() {
  const { data } = useQuery({
    queryKey: ["announcement", "latest-count"],
    queryFn: async () => {
      const res = await fetch("/api/v1/reader/rss?limit=1&group=false", { cache: "no-store" });
      if (!res.ok) return null;
      const j = await res.json();
      const d = j?.data as { total?: number; totalPages?: number } | undefined;
      return d ?? null;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const total = data?.total ?? null;
  if (total == null) return null;

  return (
    <div className="w-full bg-[var(--gold-accent)] text-black text-center text-xs font-medium py-1.5 px-4">
      Data terbaru: {total} chapters (24h) • {data?.totalPages ?? "?"} pages
    </div>
  );
}
