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
            staleTime: 60 * 1000, // 1 min
            gcTime: 5 * 60 * 1000, // 5 min (was cacheTime)
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
