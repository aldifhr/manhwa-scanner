"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export default function QueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Default tuned for RSS (fast-changing): 30s stale, 5m gc — per-query overrides for whitelist (2m/30m) & metadata (30m/60m)
            staleTime: 30 * 1000,
            gcTime: 5 * 60 * 1000, // was cacheTime
            refetchOnWindowFocus: true,
            retry: 1,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
