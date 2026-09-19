"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  function handleReset() {
    // reset TanStack error cache + Router cache agar tidak stuck sampai hard refresh
    qc.resetQueries();
    router.refresh();
    reset();
  }
  return (
    <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
      <h2 className="text-xl font-semibold text-text mb-2">
        Something went wrong
      </h2>
      <p className="text-text-muted max-w-md mb-6 text-sm">
        {error.message || "An unexpected error occurred."}
      </p>
      <button
        onClick={handleReset}
        className="px-5 py-2 rounded-lg bg-accent text-black font-medium hover:bg-accent/80 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
