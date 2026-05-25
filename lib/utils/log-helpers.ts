/**
 * Shared log normalization utilities to avoid circular dependencies
 */

export function normalizeCronLogEntry(entry?: Record<string, unknown>): any {
  const safeEntry = entry || {};
  const timestamp = String(safeEntry.timestamp ?? safeEntry.time ?? safeEntry.createdAt ?? new Date().toISOString());
  
  let message = String(safeEntry.message ?? "").trim();
  const sent = safeEntry.sent !== undefined && safeEntry.sent !== null ? (Number(safeEntry.sent) || 0) : null;
  const skipped = safeEntry.skipped !== undefined && safeEntry.skipped !== null ? (Number(safeEntry.skipped) || 0) : null;
  const failed = safeEntry.failed !== undefined && safeEntry.failed !== null ? (Number(safeEntry.failed) || 0) : null;
  
  if ((!message || message === "Unknown log") && (sent !== null || skipped !== null || failed !== null)) {
    const s = sent ?? 0;
    const k = skipped ?? 0;
    const f = failed ?? 0;
    message = `Cycle: ${s} sent, ${k} skipped${f > 0 ? `, ${f} failed` : ""}`;
  }

  let tag = String(safeEntry.tag ?? "");
  if (!tag || tag === "info") {
    if (sent && sent > 0) tag = failed && failed > 0 ? "partial" : "sent";
    else if (failed && failed > 0) tag = "failed";
    else if (skipped && skipped > 0) tag = "skipped";
    else tag = tag || "info";
  }

  return {
    timestamp,
    time: timestamp,
    tag,
    code: safeEntry.code !== null && safeEntry.code !== undefined ? String(safeEntry.code) : null,
    type: safeEntry.type !== null && safeEntry.type !== undefined ? String(safeEntry.type) : null,
    source: safeEntry.source !== null && safeEntry.source !== undefined ? String(safeEntry.source) : null,
    title: safeEntry.title !== null && safeEntry.title !== undefined ? String(safeEntry.title) : null,
    count: Number.isFinite(Number(safeEntry.count)) ? Number(safeEntry.count) : (sent || null),
    sent,
    skipped,
    failed,
    message: message || "Unknown log",
  };
}
