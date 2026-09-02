"use client";
import { normalizeOrigin, getOriginFlag } from "@/lib/constants";

export function OriginFlag({
  origin,
  className = "w-4 h-3 rounded-sm object-cover",
}: {
  origin?: string | null;
  className?: string;
}) {
  const normalized = normalizeOrigin(origin);
  const flag = getOriginFlag(normalized);
  if (!flag) return null;
  return <img src={flag} alt={normalized} className={className} />;
}
