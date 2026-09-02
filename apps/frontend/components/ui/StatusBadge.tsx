interface StatusBadgeProps {
  label: string;
  status: string;
  hexColors: Record<string, string>;
  shape?: "pill" | "rounded";
  showDot?: boolean;
}

export function StatusBadge({
  label,
  status,
  hexColors,
  shape = "pill",
  showDot = true,
}: StatusBadgeProps) {
  const color = hexColors[status] || "#888";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium capitalize ${shape === "pill" ? "rounded-full" : "rounded"}`}
      style={{ backgroundColor: color + "18", color }}
    >
      {showDot && (
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      {label}
    </span>
  );
}
