"use client";
import { normalizeOrigin, getOriginFlag } from "@/lib/constants";

export function OriginFlag({
  origin,
  type,
  className = "w-4 h-3 rounded-sm object-cover",
}: {
  origin?: string | null;
  type?: string | null;
  className?: string;
}) {
  // no type / no_type = no flag (hide flag untuk type=no_type & data lama tanpa type)
  const t = (type || "").toLowerCase().trim();
  if (!t || (t !== "manhwa" && t !== "manhua")) return null;
  const normalized = normalizeOrigin(origin);
  const flag = getOriginFlag(normalized);
  if (!flag) return null;
  return <img src={flag} alt={normalized} className={className} />;
}
