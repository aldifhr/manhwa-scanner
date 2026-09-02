"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
      <h2 className="text-xl font-semibold text-text mb-2">
        Something went wrong
      </h2>
      <p className="text-text-muted max-w-md mb-6 text-sm">
        {error.message || "An unexpected error occurred."}
      </p>
      <button
        onClick={() => reset()}
        className="px-5 py-2 rounded-lg bg-accent text-black font-medium hover:bg-accent/80 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
