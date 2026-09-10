import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Exclude | manhwa-scanner",
  description: "Excluded and completed series",
};

export default async function ExcludePage() {
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">Exclude</h1>
      <p className="text-sm text-white/60 mb-4">Excluded and completed series management.</p>
      <div className="flex gap-2 mb-4">
        <a href="/exclude-list" className="px-3 py-1 bg-white/10 rounded text-sm">All</a>
        <a href="/exclude-list?filter=excluded" className="px-3 py-1 bg-white/10 rounded text-sm">Excluded</a>
        <a href="/exclude-list?filter=completed" className="px-3 py-1 bg-white/10 rounded text-sm">Completed</a>
      </div>
      <p className="text-xs text-white/50">Use tabs to filter by status.</p>
    </div>
  );
}
