const TIME_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const DATE_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function msToSecondsLabel(ms) {
  return `${Math.round(ms / 1000)}s`;
}

export function fmt(d) {
  return TIME_FORMATTER.format(d);
}

export function parseDateSafe(value) {
  const d = new Date(value || "");
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function bucketKeyForDate(d) {
  return dateKey(d);
}

export function timelineLabel(d) {
  const now = new Date();
  const todayKey = dateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const dKey = dateKey(d);
  if (dKey === todayKey) return "Today";
  if (dKey === dateKey(yesterday)) return "Yesterday";
  return DATE_FORMATTER.format(d);
}

export function timeAgo(iso) {
  const d = parseDateSafe(iso);
  if (!d) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  const units = [
    ["hari", 86400],
    ["jam", 3600],
    ["menit", 60],
    ["detik", 1],
  ];
  for (const [label, size] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) return `${value} ${label} lalu`;
  }
  return "baru saja";
}

export function countSentLast24h(items) {
  if (!Array.isArray(items)) return 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return items.filter((item) => {
    const d = parseDateSafe(item?.sentAt || item?.enqueuedAt);
    return d && d.getTime() >= cutoff;
  }).length;
}

export function sourceName(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "shinigami") return "Shinigami";
  return "Ikiru";
}

export function sourceBadgeClass(source) {
  const s = String(source || "").toLowerCase().trim();
  return s === "ikiru" ? "source-ikiru" : "source-shinigami";
}

export function sourceDisplayName(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "shinigami") return "Shinigami";
  return "Ikiru";
}

function normalizeMarkReason(value = "") {
  const key = String(value).toLowerCase().trim().replace(/\s+/g, "_");
  if (key === "hiatus" || key === "end_season" || key === "end") return key;
  return "";
}

export function markLabel(mark) {
  const key = normalizeMarkReason(mark);
  if (key === "hiatus") return "Hiatus";
  if (key === "end_season") return "End Season";
  if (key === "end") return "End";
  return "";
}

export function cooldownText(disabledUntil) {
  const target = parseDateSafe(disabledUntil);
  if (!target) return null;
  const now = Date.now();
  const diffMs = target.getTime() - now;
  if (diffMs <= 0) return "ready";

  const totalSeconds = Math.ceil(diffMs / 1000);
  if (totalSeconds < 120) {
    return `retry ${totalSeconds}s`;
  }
  const mins = Math.ceil(totalSeconds / 60);
  return `retry ${mins}m`;
}

export function getCssVar(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

export function logSentCount(log) {
  const count = Number(log?.count);
  if (log?.tag === "sent" || log?.tag === "partial") {
    return Number.isFinite(count) && count > 0 ? count : 1;
  }
  return 0;
}

export function logFailedCount(log) {
  const failed = Number(log?.failed);
  if (log?.tag === "partial") {
    return Number.isFinite(failed) && failed > 0 ? failed : 0;
  }
  if (log?.tag === "failed") {
    return Number.isFinite(failed) && failed > 0 ? failed : 1;
  }
  return 0;
}
