"use client";
import { sourceChipClass, sourceBadgeClass } from "@/lib/styles";

export function SourceChip({
  source,
  variant = "chip",
}: {
  source: string;
  variant?: "chip" | "badge";
}) {
  if (source.toLowerCase() === "voratoon") return null;
  const cls =
    variant === "badge" ? sourceBadgeClass(source) : sourceChipClass(source);
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded capitalize ${cls}`}
    >
      {source}
    </span>
  );
}
