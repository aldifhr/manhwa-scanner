import dayjs from "dayjs";

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = dayjs(dateStr);
  if (!d.isValid()) return "";
  const mins = dayjs().diff(d, "minute");
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = dayjs().diff(d, "hour");
  if (hrs < 24) return `${hrs}h ago`;
  const days = dayjs().diff(d, "day");
  if (days < 30) return `${days}d ago`;
  return d.format("MMM D");
}

export { timeAgo };