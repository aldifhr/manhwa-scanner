const API_BASE = "";
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_HEAVY_POLL_MS = 300_000;
const HIDDEN_TAB_MULTIPLIER = 3;
const FOCUS_REFRESH_COOLDOWN_MS = 30_000;
const ALLOWED_POLL_MS = [30_000, 60_000, 120_000];
const elementCache = new Map();
const $ = (id) => {
  if (!elementCache.has(id)) elementCache.set(id, document.getElementById(id));
  return elementCache.get(id);
};

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

let isAuthenticated = false;
let lightPollTimer = null;
let heavyPollTimer = null;
let pollMs = Number(localStorage.getItem("ikiru_poll_ms") || DEFAULT_POLL_MS);
if (!ALLOWED_POLL_MS.includes(pollMs)) pollMs = DEFAULT_POLL_MS;
let autoRefreshEnabled = localStorage.getItem("ikiru_auto_refresh") !== "off";
let isProcessing = false;
let loadAbortController = null;
let lightAbortController = null;
let heavyAbortController = null;
let lastHeavyLoadAt = 0;
let lastLightLoadAt = 0;
let lastFocusRefreshAt = 0;
let latestStatusData = null;
let latestWhitelistData = null;
let latestRecentData = null;
let whitelistItems = [];
let whitelistSortOrder = "default";
let compareItems = [];
let logsItems = [];
let recentItems = [];
let trendChart = null;
let sourceChart = null;
let pendingDeleteResolver = null;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function resolveHeavyPollMs() {
  return Math.max(DEFAULT_HEAVY_POLL_MS, pollMs * 4);
}

function currentLightPollMs() {
  return document.hidden ? pollMs * HIDDEN_TAB_MULTIPLIER : pollMs;
}

function currentHeavyPollMs() {
  const base = resolveHeavyPollMs();
  return document.hidden ? base * HIDDEN_TAB_MULTIPLIER : base;
}

function msToSecondsLabel(ms) {
  return `${Math.round(ms / 1000)}s`;
}

function fmt(d) {
  return TIME_FORMATTER.format(d);
}

function parseDateSafe(value) {
  const d = new Date(value || "");
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayDiff(a, b) {
  const one = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const two = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((one - two) / 86400000);
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timelineLabel(d) {
  const now = new Date();
  const todayKey = dateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = dateKey(yesterday);
  const dKey = dateKey(d);
  if (dKey === todayKey) return "Today";
  if (dKey === yKey) return "Yesterday";
  return DATE_FORMATTER.format(d);
}

function timeAgo(iso) {
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

function countSentLast24h(items) {
  if (!Array.isArray(items)) return 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return items.filter((i) => {
    const d = parseDateSafe(i?.sentAt);
    return d && d.getTime() >= cutoff;
  }).length;
}

function toRecentSourceFamily(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "shinigami_mirror") return "Mirror";
  if (s === "shinigami_project" || s === "shinigami") return "Project";
  return "Ikiru";
}

function sourceName(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "shinigami_project") return "Project";
  if (s === "shinigami_mirror") return "Mirror";
  if (s === "shinigami") return "Shinigami";
  return "Ikiru";
}

function sourceBadgeClass(source) {
  const s = String(source || "").toLowerCase().trim();
  return s === "ikiru" ? "source-ikiru" : "source-shinigami";
}

function sourceDisplayName(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "shinigami_project") return "Shinigami (Project)";
  if (s === "shinigami_mirror") return "Shinigami (Mirror)";
  return "Ikiru";
}

function normalizeTitleKey(value = "") {
  return String(value).toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function clampList(items, max = 6) {
  return Array.isArray(items) ? items.slice(0, max) : [];
}

function safeText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function renderSimpleList(listId, countId, items, emptyText, renderer) {
  const list = $(listId);
  const badge = $(countId);
  if (badge) badge.textContent = Array.isArray(items) ? items.length : 0;
  if (!list) return;
  if (!Array.isArray(items) || !items.length) {
    list.innerHTML = `<li class="empty">${esc(emptyText)}</li>`;
    return;
  }
  list.innerHTML = items.map(renderer).join("");
}

function sourceReliabilityScore(source, health, logs) {
  let score = 100;
  const failures = Number(health?.consecutiveFailures ?? 0);
  if (health?.status === "degraded") score -= 35;
  score -= Math.min(25, failures * 8);
  if (health?.lastError) score -= 8;

  const sourceNameLower = String(source || "").toLowerCase();
  const failedLogHits = (Array.isArray(logs) ? logs : []).filter((log) => {
    const text = `${log?.message || ""} ${log?.title || ""}`.toLowerCase();
    return log?.tag === "failed" && text.includes(sourceNameLower.replace("_", " "));
  }).length;
  score -= Math.min(18, failedLogHits * 6);

  return Math.max(0, Math.min(100, score));
}

function deriveInsights({
  statusData,
  whitelistData,
  recentData,
  logsData,
  compareData,
}) {
  const whitelist = Array.isArray(whitelistData?.items) ? whitelistData.items : [];
  const recent = Array.isArray(recentData?.items) ? recentData.items : [];
  const logs = Array.isArray(logsData?.logs) ? logsData.logs : [];
  const comparisons = Array.isArray(compareData?.comparisons) ? compareData.comparisons : [];

  const titleBuckets = new Map();
  for (const item of recent) {
    const title = safeText(item?.title, "Untitled");
    const key = normalizeTitleKey(title);
    const ts = parseDateSafe(item?.sentAt)?.getTime() || 0;
    if (!titleBuckets.has(key)) {
      titleBuckets.set(key, {
        title,
        count: 0,
        lastSeenAt: item?.sentAt || null,
        sourceCounts: { Ikiru: 0, Project: 0, Mirror: 0 },
        timestamps: [],
      });
    }
    const bucket = titleBuckets.get(key);
    bucket.count += 1;
    if (ts && (!bucket.lastSeenAt || ts > parseDateSafe(bucket.lastSeenAt)?.getTime())) {
      bucket.lastSeenAt = item?.sentAt || bucket.lastSeenAt;
    }
    bucket.sourceCounts[toRecentSourceFamily(item?.source)] += 1;
    if (item?.sentAt) bucket.timestamps.push(item.sentAt);
  }

  const topTitles = [...titleBuckets.values()]
    .sort((a, b) => b.count - a.count || safeText(a.title).localeCompare(safeText(b.title)))
    .slice(0, 8);

  const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const item of recent) {
    const d = parseDateSafe(item?.sentAt);
    if (!d) continue;
    hourBuckets[d.getHours()].count += 1;
  }
  const peakHour = hourBuckets.reduce((best, current) => (current.count > best.count ? current : best), { hour: 0, count: 0 });

  const uniqueDays = [...new Set(recent
    .map((item) => parseDateSafe(item?.sentAt))
    .filter(Boolean)
    .map((d) => dateKey(d)))].sort().reverse();
  let activityStreak = 0;
  if (uniqueDays.length) {
    let cursor = parseDateSafe(uniqueDays[0]);
    for (const key of uniqueDays) {
      const current = parseDateSafe(key);
      if (!current || !cursor) break;
      if (dayDiff(cursor, current) === 0) {
        activityStreak += 1;
        const next = new Date(cursor);
        next.setDate(next.getDate() - 1);
        cursor = next;
      } else {
        break;
      }
    }
  }

  const compareBuckets = new Map();
  for (const item of comparisons) {
    const key = normalizeTitleKey(item?.title || "");
    if (!key) continue;
    if (!compareBuckets.has(key)) {
      compareBuckets.set(key, {
        title: safeText(item?.title, "Untitled"),
        total: 0,
        ikiruWins: 0,
        shinigamiWins: 0,
        ties: 0,
        avgDeltaMinutes: 0,
      });
    }
    const bucket = compareBuckets.get(key);
    bucket.total += 1;
    bucket.avgDeltaMinutes += Number(item?.deltaMinutes ?? 0);
    if (item?.winner === "ikiru") bucket.ikiruWins += 1;
    else if (item?.winner === "shinigami") bucket.shinigamiWins += 1;
    else bucket.ties += 1;
  }
  const compareLeaderboard = [...compareBuckets.values()]
    .map((item) => ({ ...item, avgDeltaMinutes: Math.round(item.avgDeltaMinutes / Math.max(1, item.total)) }))
    .sort((a, b) => b.total - a.total || b.shinigamiWins - a.shinigamiWins || a.title.localeCompare(b.title))
    .slice(0, 8);

  const lastSeenByTitle = new Map();
  for (const item of recent) {
    const key = normalizeTitleKey(item?.title || "");
    const seenAt = parseDateSafe(item?.sentAt);
    if (!key || !seenAt) continue;
    const current = lastSeenByTitle.get(key);
    if (!current || seenAt.getTime() > current.seenAt.getTime()) {
      lastSeenByTitle.set(key, {
        title: safeText(item?.title, "Untitled"),
        seenAt,
        source: item?.source || "ikiru",
        chapter: safeText(item?.chapter, "-"),
      });
    }
  }

  const whitelistLastSeen = whitelist
    .map((item) => {
      const key = normalizeTitleKey(item?.title || "");
      const hit = lastSeenByTitle.get(key);
      return {
        title: safeText(item?.title, "Untitled"),
        source: item?.source || "ikiru",
        mark: item?.mark || null,
        lastSeenAt: hit?.seenAt?.toISOString?.() || null,
        chapter: hit?.chapter || null,
      };
    })
    .sort((a, b) => {
      const ta = parseDateSafe(a.lastSeenAt)?.getTime() ?? 0;
      const tb = parseDateSafe(b.lastSeenAt)?.getTime() ?? 0;
      return tb - ta || a.title.localeCompare(b.title);
    });

  const missedDetector = whitelistLastSeen
    .filter((item) => !item.lastSeenAt)
    .slice(0, 10);

  const sourceReliability = Object.entries(statusData?.sourceHealth || {})
    .map(([source, health]) => ({
      source,
      label: sourceDisplayName(source),
      score: sourceReliabilityScore(source, health, logs),
      status: health?.status || "unknown",
      consecutiveFailures: Number(health?.consecutiveFailures ?? 0),
      lastSuccessAt: health?.lastSuccessAt || null,
      lastError: health?.lastError || null,
    }))
    .sort((a, b) => b.score - a.score);

  const failedMonitor = logs
    .filter((log) => log?.tag === "failed")
    .slice(0, 10)
    .map((log) => ({
      title: safeText(log?.title || log?.message, "Unknown failure"),
      message: safeText(log?.message, "-"),
      time: log?.time || null,
    }));

  const sourceMixMap = new Map();
  for (const item of recent) {
    const label = toRecentSourceFamily(item?.source);
    sourceMixMap.set(label, (sourceMixMap.get(label) || 0) + 1);
  }
  const sourceMix = [...sourceMixMap.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    activityStreak,
    peakHour,
    topTitles,
    compareLeaderboard,
    whitelistLastSeen: whitelistLastSeen.slice(0, 10),
    missedDetector,
    sourceReliability,
    failedMonitor,
    sourceMix,
    missedCount: missedDetector.length,
    failCount: failedMonitor.length,
  };
}

function normalizeMarkReason(value = "") {
  const key = String(value).toLowerCase().trim().replace(/\s+/g, "_");
  if (key === "hiatus" || key === "end_season" || key === "end") return key;
  return "";
}

function markLabel(mark) {
  const key = normalizeMarkReason(mark);
  if (key === "hiatus") return "Hiatus";
  if (key === "end_season") return "End Season";
  if (key === "end") return "End";
  return "";
}

function cooldownText(disabledUntil) {
  const target = parseDateSafe(disabledUntil);
  if (!target) return null;
  const mins = Math.ceil((target.getTime() - Date.now()) / 60000);
  if (mins <= 0) return "retry now";
  return `retry ${mins}m`;
}

function getCssVar(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function ensureChartsDestroyed() {
  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }
  if (sourceChart) {
    sourceChart.destroy();
    sourceChart = null;
  }
}

function renderTrendChart() {
  const canvas = $("chartTrend");
  if (!canvas || !window.Chart) return;

  const range = $("chartRange")?.value || "24h";
  const now = new Date();
  let buckets = [];
  const sent = [];
  const skipped = [];
  const failed = [];

  if (range === "7d") {
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      buckets.push({
        key: dateKey(d),
        label: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
      });
      sent.push(0);
      skipped.push(0);
      failed.push(0);
    }

    for (const log of logsItems) {
      const d = parseDateSafe(log?.time);
      if (!d) continue;
      const idx = buckets.findIndex((b) => b.key === dateKey(d));
      if (idx === -1) continue;
      if (log.tag === "sent") sent[idx] += 1;
      if (log.tag === "skipped") skipped[idx] += 1;
      if (log.tag === "failed") failed[idx] += 1;
    }
  } else {
    for (let i = 23; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setHours(now.getHours() - i, 0, 0, 0);
      buckets.push({
        key: `${dateKey(d)}-${d.getHours()}`,
        label: `${String(d.getHours()).padStart(2, "0")}:00`,
      });
      sent.push(0);
      skipped.push(0);
      failed.push(0);
    }

    for (const log of logsItems) {
      const d = parseDateSafe(log?.time);
      if (!d) continue;
      const key = `${dateKey(d)}-${d.getHours()}`;
      const idx = buckets.findIndex((b) => b.key === key);
      if (idx === -1) continue;
      if (log.tag === "sent") sent[idx] += 1;
      if (log.tag === "skipped") skipped[idx] += 1;
      if (log.tag === "failed") failed[idx] += 1;
    }
  }

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: buckets.map((b) => b.label),
      datasets: [
        { label: "sent", data: sent, borderColor: getCssVar("--green", "#1b8f5a"), backgroundColor: "transparent", tension: 0.25 },
        { label: "skipped", data: skipped, borderColor: getCssVar("--amber", "#b06b17"), backgroundColor: "transparent", tension: 0.25 },
        { label: "failed", data: failed, borderColor: getCssVar("--red", "#c0392b"), backgroundColor: "transparent", tension: 0.25 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: getCssVar("--muted", "#777") } } },
      scales: {
        x: { ticks: { color: getCssVar("--muted", "#777"), maxTicksLimit: range === "7d" ? 7 : 8 }, grid: { color: "transparent" } },
        y: { ticks: { color: getCssVar("--muted", "#777"), precision: 0 }, grid: { color: "rgba(120,120,120,.12)" }, beginAtZero: true },
      },
    },
  });
}

function renderSourceChart() {
  const canvas = $("chartSourceHealth");
  if (!canvas || !window.Chart) return;

  let ikiru = 0;
  let project = 0;
  let mirror = 0;
  for (const item of recentItems) {
    const s = String(item?.source || "ikiru").toLowerCase();
    if (s === "shinigami_project") project += 1;
    else if (s === "shinigami_mirror") mirror += 1;
    else ikiru += 1;
  }

  if (sourceChart) sourceChart.destroy();
  sourceChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Ikiru", "Project", "Mirror"],
      datasets: [
        {
          label: "updates",
          data: [ikiru, project, mirror],
          backgroundColor: [
            getCssVar("--green", "#1b8f5a"),
            getCssVar("--amber", "#b06b17"),
            getCssVar("--accent-2", "#1b9aaa"),
          ],
          borderRadius: 8,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: getCssVar("--muted", "#777") }, grid: { color: "transparent" } },
        y: { beginAtZero: true, ticks: { color: getCssVar("--muted", "#777"), precision: 0 }, grid: { color: "rgba(120,120,120,.12)" } },
      },
    },
  });
}

function skeleton(ul, n = 4) {
  ul.innerHTML = Array.from({ length: n }, () => `<li style="padding:10px 12px"><div class="skel"></div></li>`).join("");
}

function skeletonRecent(ul, n = 4) {
  ul.innerHTML = Array.from({ length: n }, () => `<li style="padding:10px 12px"><div class="skel" style="width:70%"></div></li>`).join("");
}

function showAlert(msg) {
  const el = $("alertBox");
  el.style.display = "block";
  el.textContent = msg;
  setTimeout(() => {
    el.style.display = "none";
  }, 8000);
  showToast(msg, "warn");
}

function clearAlert() {
  $("alertBox").style.display = "none";
}

function showToast(message, type = "success", timeoutMs = 2600) {
  const wrap = $("toastContainer");
  if (!wrap) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = String(message || "");
  wrap.appendChild(toast);
  setTimeout(() => toast.remove(), timeoutMs);
}

function openDeleteConfirm(title) {
  const overlay = $("deleteConfirmOverlay");
  const text = $("deleteConfirmText");
  if (!overlay || !text) return Promise.resolve(true);
  text.textContent = `Yakin ingin menghapus "${title}" dari whitelist?`;
  overlay.classList.add("show");
  return new Promise((resolve) => {
    pendingDeleteResolver = resolve;
  });
}

function resolveDeleteConfirm(accepted) {
  const overlay = $("deleteConfirmOverlay");
  if (overlay) overlay.classList.remove("show");
  if (pendingDeleteResolver) pendingDeleteResolver(Boolean(accepted));
  pendingDeleteResolver = null;
}

function renderErr(ul, msg) {
  ul.innerHTML = `<li class="empty">${esc(msg)} <button class="btn-mini" onclick="loadAll()">retry</button></li>`;
}

function renderLiveHeader(statusData) {
  $("liveSent").textContent = `S:${statusData?.sent ?? "-"}`;
  $("liveSkipped").textContent = `K:${statusData?.skipped ?? "-"}`;
  $("liveFailed").textContent = `F:${statusData?.failed ?? "-"}`;
  $("liveGuilds").textContent = `G:${statusData?.guilds ?? "-"}`;
  $("liveDuration").textContent = `D:${statusData?.duration ? `${statusData.duration}s` : "-"}`;
}

function renderStatsExtended(statusData) {
  const dot = $("statusDot");
  if (!statusData) {
    ["statSent", "statSkipped", "statFailed", "statDuration"].forEach((id) => ($(id).textContent = "-"));
    dot.className = "logo-dot offline";
    renderLiveHeader(null);
    return;
  }
  $("statSent").textContent = statusData.sent ?? "-";
  $("statSkipped").textContent = statusData.skipped ?? "-";
  $("statFailed").textContent = statusData.failed ?? "-";
  $("statDuration").textContent = statusData.duration ? `${statusData.duration}s` : "-";
  dot.className = "logo-dot" + (Number(statusData.failed || 0) > 0 ? " offline" : "");
  renderLiveHeader(statusData);
}

function renderOverview(statusData, whitelistData, recentData) {
  const healthEl = $("overviewHealth");
  const lastRunEl = $("overviewLastRun");
  const whitelistEl = $("overviewWhitelist");
  const sent24hEl = $("overviewSent24h");

  if (!statusData) {
    healthEl.textContent = "-";
    lastRunEl.textContent = "-";
    whitelistEl.textContent = "-";
    sent24hEl.textContent = "-";
    healthEl.className = "stat-value";
    return;
  }

  const degraded = Number(statusData.failed ?? 0) > 0 || Object.values(statusData.sourceHealth || {}).some((s) => s?.status === "degraded");
  healthEl.textContent = degraded ? "DEGRADED" : "HEALTHY";
  healthEl.className = `stat-value ${degraded ? "amber" : "green"}`;

  lastRunEl.textContent = statusData.timestamp ? timeAgo(statusData.timestamp) : "-";
  whitelistEl.textContent = Array.isArray(whitelistData?.items) ? whitelistData.items.length : "-";
  sent24hEl.textContent = countSentLast24h(recentData?.items);
}

function renderLastCronResult(statusData, fromManual = false) {
  const bar = $("lastCronBar");
  if (!statusData) {
    $("lastCronSent").textContent = "sent: -";
    $("lastCronSkipped").textContent = "skipped: -";
    $("lastCronFailed").textContent = "failed: -";
    $("lastCronDuration").textContent = "duration: -";
    $("lastCronTime").textContent = "-";
    bar.className = "hero-card";
    return;
  }

  $("lastCronSent").textContent = `sent: ${statusData.sent ?? 0}`;
  $("lastCronSkipped").textContent = `skipped: ${statusData.skipped ?? 0}`;
  $("lastCronFailed").textContent = `failed: ${statusData.failed ?? 0}`;
  $("lastCronDuration").textContent = `duration: ${statusData.duration ? `${statusData.duration}s` : "-"}`;
  $("lastCronTime").textContent = `${fromManual ? "manual" : "otomatis"} - ${statusData.timestamp ? timeAgo(statusData.timestamp) : "baru saja"}`;
  bar.className = "hero-card";
}

function renderSourceHealth(statusData) {
  const list = $("sourceHealthList");
  const entries = Object.entries(statusData?.sourceHealth || {});
  $("sourceHealthCount").textContent = entries.length;

  if (!entries.length) {
    list.innerHTML = '<li class="empty">Belum ada data source health.</li>';
    return;
  }

  list.innerHTML = entries
    .map(([source, health], i) => {
      const degraded = health?.status === "degraded";
      const failures = Number(health?.consecutiveFailures ?? 0);
      const extra = degraded ? cooldownText(health?.disabledUntil) || "cooldown" : `ok${health?.lastSuccessAt ? ` (${timeAgo(health.lastSuccessAt)})` : ""}`;
      return `<li class="manga-item">
        <span class="manga-index">${String(i + 1).padStart(2, "0")}</span>
        <span class="manga-item-title">${esc(sourceDisplayName(source))}<br /><small style="opacity:.7">fail streak: ${failures}${health?.lastError ? ` | ${esc(health.lastError)}` : ""}</small></span>
        <span class="status-pill ${degraded ? "invalid" : "active"}">${degraded ? "degraded" : "healthy"}</span>
        <span class="badge">${esc(extra || "-")}</span>
      </li>`;
    })
    .join("");
}

function highlight(text, query) {
  if (!query) return esc(text);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  return esc(text).replace(re, "<mark>$1</mark>");
}

function copyUrl(url) {
  if (!url) {
    showAlert("URL tidak tersedia");
    return;
  }
  navigator.clipboard.writeText(String(url)).then(
    () => showAlert("URL copied"),
    () => showAlert("Gagal copy URL"),
  );
}

function quickCheckMatch(title) {
  const key = normalizeTitleKey(title);
  const hit = compareItems.find((item) => normalizeTitleKey(item.title) === key || normalizeTitleKey(item.title).includes(key) || key.includes(normalizeTitleKey(item.title)));
  if (!hit) {
    showAlert(`Belum ada data compare match untuk "${title}"`);
    return;
  }
  const winnerText = hit.winner === "ikiru" ? "Ikiru lebih cepat" : hit.winner === "shinigami" ? "Shinigami lebih cepat" : "Tie";
  showAlert(`${hit.title} - ${hit.chapter} | ${winnerText} (${Number(hit.deltaMinutes ?? 0)} menit)`);
}

function applyWhitelistFilter() {
  const query = ($("inputWhitelistSearch")?.value ?? "").trim().toLowerCase();
  const sourceFilter = ($("inputWhitelistSource")?.value ?? "").trim().toLowerCase();
  const list = $("mangaList");

  const entries = whitelistItems.map((item, originalIndex) => {
    const title = typeof item === "string" ? item : item.title;
    const source = typeof item === "object" ? String(item.source || "ikiru").toLowerCase() : "ikiru";
    return {
      item,
      title,
      source,
      titleLower: String(title).toLowerCase(),
      originalIndex,
    };
  });

  if (whitelistSortOrder === "az") entries.sort((a, b) => a.titleLower.localeCompare(b.titleLower));
  if (whitelistSortOrder === "za") entries.sort((a, b) => b.titleLower.localeCompare(a.titleLower));

  const filtered = entries.filter((entry) => {
    if (query && !entry.titleLower.includes(query)) return false;
    if (sourceFilter && entry.source !== sourceFilter) return false;
    return true;
  });

  $("whitelistCount").textContent = whitelistItems.length;

  if (!filtered.length) {
    list.innerHTML = '<li class="empty">Tidak ada hasil filter.</li>';
    return;
  }

  list.innerHTML = filtered
    .map((entry, idx) => {
      const { item, title, source, originalIndex } = entry;
      const url = typeof item === "object" ? item.url : null;
      const mark = typeof item === "object" ? markLabel(item.mark) : "";
      const sourceLabel = sourceName(source);
      const badgeClass = sourceBadgeClass(source);
      const displayIndex = whitelistSortOrder === "default" ? originalIndex : idx;
      return `<li class="manga-item" title="${url ? esc(url) : ""}">
        <span class="manga-index">${String(displayIndex + 1).padStart(2, "0")}</span>
        <span class="manga-item-title">${highlight(title, query)}${mark ? ` <span class="badge">${esc(mark)}</span>` : ""}</span>
        <span class="source-badge ${badgeClass}">${esc(sourceLabel)}</span>
        <button class="btn-mini" onclick="quickCheckMatch('${esc(title)}')">match</button>
        <button class="btn-mini" onclick="copyUrl('${esc(url || "")}')">copy</button>
        <button class="btn-delete" onclick="deleteManga('${esc(title)}')">x</button>
      </li>`;
    })
    .join("");
}

function renderWhitelist(data) {
  latestWhitelistData = data ?? latestWhitelistData;
  whitelistItems = data?.items ?? [];
  applyWhitelistFilter();
}

function setSortOrder(order) {
  whitelistSortOrder = order;
  ["default", "az", "za"].forEach((o) => {
    const btn = $(`sortBtn_${o}`);
    if (btn) btn.classList.toggle("active", o === order);
  });
  applyWhitelistFilter();
}

function renderTimelineList(ul, items, rowRenderer, getDateValue) {
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Belum ada data.</li>';
    return;
  }

  let html = "";
  let lastKey = "";
  for (const item of items) {
    const d = parseDateSafe(getDateValue(item));
    const key = d ? dateKey(d) : "unknown";
    if (key !== lastKey) {
      html += `<li class="timeline-group">${d ? timelineLabel(d) : "Unknown date"}</li>`;
      lastKey = key;
    }
    html += rowRenderer(item);
  }
  ul.innerHTML = html;
}

function renderRecent(data) {
  const list = $("recentList");
  recentItems = data?.items ?? [];
  $("recentCount").textContent = recentItems.length;

  renderTimelineList(
    list,
    recentItems,
    (item) => {
      const cover = item.cover
        ? `<img class="recent-cover" src="${esc(item.cover)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="recent-cover-placeholder" style="display:none">img</div>`
        : '<div class="recent-cover-placeholder">img</div>';
      return `<a class="recent-item" href="${item.url ? esc(item.url) : "#"}" target="_blank" rel="noopener">
        ${cover}
        <div class="recent-info">
          <div class="recent-title">${esc(item.title)}</div>
          <div class="recent-chapter">${esc(item.chapter || "-")} - <span class="source-badge ${sourceBadgeClass(item.source)}">${esc(sourceName(item.source))}</span></div>
        </div>
        <span class="recent-time">${item.sentAt ? timeAgo(item.sentAt) : "-"}</span>
      </a>`;
    },
    (item) => item.sentAt,
  );

  renderSourceChart();
}

function renderSourceCompare(data) {
  const summary = data?.summary ?? {};
  const sourceCounts = data?.sourceCounts ?? {};
  compareItems = data?.comparisons ?? [];

  $("compareCount").textContent = summary.totalCompared ?? 0;
  $("compareIkiruWins").textContent = summary.ikiruWins ?? 0;
  $("compareShinigamiWins").textContent = summary.shinigamiWins ?? 0;
  $("compareTies").textContent = summary.ties ?? 0;
  $("sourceCountIkiru").textContent = sourceCounts.ikiru ?? 0;
  $("sourceCountShinigami").textContent = (sourceCounts.shinigami_project ?? 0) + (sourceCounts.shinigami_mirror ?? 0);

  const list = $("compareList");
  if (!compareItems.length) {
    list.innerHTML = '<li class="empty">Belum ada data compare judul/chapter yang sama.</li>';
    return;
  }

  list.innerHTML = compareItems
    .map((item, i) => {
      const winnerText = item.winner === "ikiru" ? "Ikiru lebih cepat" : item.winner === "shinigami" ? "Shinigami lebih cepat" : "Tie";
      return `<li class="manga-item">
        <span class="manga-index">${String(i + 1).padStart(2, "0")}</span>
        <span class="manga-item-title">${esc(item.title)} - ${esc(item.chapter)}<br /><small style="opacity:.7">${esc(winnerText)} (${Number(item.deltaMinutes ?? 0)} menit)</small></span>
      </li>`;
    })
    .join("");
}

function renderDerivedInsights() {
  const insights = deriveInsights({
    statusData: latestStatusData,
    whitelistData: latestWhitelistData,
    recentData: latestRecentData,
    logsData: { logs: logsItems },
    compareData: { comparisons: compareItems },
  });

  $("opsStreakValue").textContent = insights.activityStreak ? `${insights.activityStreak}d` : "0d";
  $("opsPeakHourValue").textContent = insights.peakHour.count ? `${String(insights.peakHour.hour).padStart(2, "0")}:00` : "-";
  $("opsTopTitleValue").textContent = insights.topTitles[0]?.title || "-";
  $("opsMissedValue").textContent = insights.missedCount;
  $("opsFailValue").textContent = insights.failCount;

  renderSimpleList(
    "topTitlesList",
    "topTitlesCount",
    insights.topTitles,
    "Belum ada title aktif di recent feed.",
    (item, index) => `<li class="manga-item">
      <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.title)}<br /><small style="opacity:.7">${item.count} update | last seen ${esc(timeAgo(item.lastSeenAt))}</small></span>
      <span class="badge">${esc(`I:${item.sourceCounts.Ikiru} P:${item.sourceCounts.Project} M:${item.sourceCounts.Mirror}`)}</span>
    </li>`,
  );

  renderSimpleList(
    "compareLeaderboardList",
    "compareLeaderboardCount",
    insights.compareLeaderboard,
    "Belum ada leaderboard compare.",
    (item, index) => `<li class="manga-item">
      <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.title)}<br /><small style="opacity:.7">I:${item.ikiruWins} S:${item.shinigamiWins} T:${item.ties} | avg gap ${item.avgDeltaMinutes} menit</small></span>
      <span class="badge">${esc(`${item.total} compare`)}</span>
    </li>`,
  );

  renderSimpleList(
    "whitelistLastSeenList",
    "whitelistLastSeenCount",
    insights.whitelistLastSeen,
    "Belum ada data whitelist.",
    (item, index) => `<li class="manga-item">
      <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.title)}${item.mark ? ` <span class="badge">${esc(markLabel(item.mark))}</span>` : ""}<br /><small style="opacity:.7">${item.lastSeenAt ? `last seen ${esc(timeAgo(item.lastSeenAt))}${item.chapter ? ` | ${esc(item.chapter)}` : ""}` : "belum muncul di recent feed"}</small></span>
      <span class="source-badge ${sourceBadgeClass(item.source)}">${esc(sourceName(item.source))}</span>
    </li>`,
  );

  renderSimpleList(
    "missedDetectorList",
    "missedDetectorCount",
    insights.missedDetector,
    "Semua whitelist muncul di recent feed saat ini.",
    (item, index) => `<li class="manga-item">
      <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.title)}<br /><small style="opacity:.7">belum terlihat di recent feed terbaru</small></span>
      <span class="source-badge ${sourceBadgeClass(item.source)}">${esc(sourceName(item.source))}</span>
    </li>`,
  );

  renderSimpleList(
    "sourceReliabilityList",
    "sourceReliabilityCount",
    insights.sourceReliability,
    "Belum ada data reliability source.",
    (item, index) => `<li class="manga-item">
      <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.label)}<br /><small style="opacity:.7">${item.lastSuccessAt ? `last success ${esc(timeAgo(item.lastSuccessAt))}` : "no success yet"}${item.lastError ? ` | ${esc(item.lastError)}` : ""}</small></span>
      <span class="status-pill ${item.score >= 80 ? "active" : item.score >= 55 ? "" : "invalid"}">${item.score}/100</span>
      <span class="badge">${esc(item.status)}</span>
    </li>`,
  );

  renderSimpleList(
    "failedMonitorList",
    "failedMonitorCount",
    insights.failedMonitor,
    "Belum ada failed send di log terbaru.",
    (item, index) => `<li class="manga-item">
      <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.title)}<br /><small style="opacity:.7">${esc(item.message)}</small></span>
      <span class="badge">${esc(item.time ? timeAgo(item.time) : "-")}</span>
    </li>`,
  );

  renderSimpleList(
    "sourceMixList",
    "sourceMixCount",
    insights.sourceMix,
    "Belum ada source mix.",
    (item, index) => `<li class="manga-item">
      <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.label)}<br /><small style="opacity:.7">distribusi recent delivery</small></span>
      <span class="badge">${esc(`${item.count} item`)}</span>
    </li>`,
  );
}

function renderLogs(data) {
  logsItems = data?.logs ?? [];
  const list = $("logList");
  $("logCount").textContent = `${logsItems.length} entries`;

  renderTimelineList(
    list,
    logsItems,
    (log) => `<li class="log-item">
      <span class="log-time">${fmt(new Date(log.time || Date.now()))}</span>
      <span>${esc(log.message || "-")}</span>
      <span class="log-tag ${esc(log.tag || "info")}">${esc(log.tag || "info")}</span>
    </li>`,
    (log) => log.time,
  );

  renderTrendChart();
  renderDerivedInsights();
}

async function addManga() {
  const titleInput = $("inputMangaTitle");
  const urlInput = $("inputMangaUrl");
  const btn = $("btnAddManga");
  const title = titleInput.value.trim();
  const url = urlInput.value.trim();

  if (!title) {
    titleInput.focus();
    return;
  }

  isProcessing = true;
  btn.disabled = true;
  btn.textContent = "...";

  try {
    const r = await fetch(`${API_BASE}/api/whitelist`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, url: url || null }),
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Gagal menambah manga");
      return;
    }
    titleInput.value = "";
    urlInput.value = "";
    renderWhitelist(data);
    showToast("Manga berhasil ditambahkan", "success");
  } catch (e) {
    showAlert(`Gagal: ${e.message}`);
  } finally {
    isProcessing = false;
    btn.disabled = false;
    btn.textContent = "+ Tambah";
  }
}

async function deleteManga(title) {
  const ok = await openDeleteConfirm(title);
  if (!ok) return;
  isProcessing = true;
  try {
    const r = await fetch(`${API_BASE}/api/whitelist`, {
      method: "DELETE",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Gagal menghapus");
      return;
    }
    renderWhitelist(data);
    showToast("Manga berhasil dihapus", "success");
  } catch (e) {
    showAlert(`Gagal: ${e.message}`);
  } finally {
    isProcessing = false;
  }
}

async function runCronNow() {
  if (!checkAuth() || isProcessing) return;
  const btn = $("btnRunCron");
  const oldText = btn?.textContent || "jalankan cron";
  isProcessing = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "running...";
  }

  try {
    const r = await fetch(`${API_BASE}/api/cron`, { method: "GET", cache: "no-store" });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Cron gagal dijalankan");
      return;
    }
    showAlert(`Cron selesai: sent ${data.sent ?? 0}, skipped ${data.skipped ?? 0}, failed ${data.failed ?? 0}`);
    renderLastCronResult(
      {
        sent: data.sent,
        skipped: data.skipped,
        failed: data.failed,
        duration: data.duration,
        timestamp: new Date().toISOString(),
      },
      true,
    );
    await loadAll();
  } catch (e) {
    showAlert(`Gagal trigger cron: ${e.message}`);
  } finally {
    isProcessing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

function checkAuth() {
  if (!isAuthenticated) {
    $("modalOverlay").classList.add("show");
    return false;
  }
  return true;
}

async function submitPassword() {
  const input = $("passwordInput");
  const password = input.value.trim();
  if (!password) return;

  try {
    const r = await fetch(`${API_BASE}/api/login`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Login gagal");
      return;
    }

    isAuthenticated = true;
    input.value = "";
    $("modalOverlay").classList.remove("show");
    await loadAll();
    startPoll();
  } catch (e) {
    showAlert(`Login gagal: ${e.message}`);
  }
}

$("passwordInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPassword();
});
$("deleteCancelBtn")?.addEventListener("click", () => resolveDeleteConfirm(false));
$("deleteConfirmBtn")?.addEventListener("click", () => resolveDeleteConfirm(true));
$("deleteConfirmOverlay")?.addEventListener("click", (e) => {
  if (e.target === $("deleteConfirmOverlay")) resolveDeleteConfirm(false);
});

async function logoutDashboard() {
  try {
    await fetch(`${API_BASE}/api/logout`, { method: "POST", cache: "no-store" });
  } catch (_e) {
    // noop
  }
  isAuthenticated = false;
  $("modalOverlay").classList.add("show");
  clearInterval(lightPollTimer);
  clearInterval(heavyPollTimer);
}

async function bootstrapAuth() {
  try {
    const r = await fetch(`${API_BASE}/api/auth-status`, { method: "GET", cache: "no-store" });
    const data = await r.json();
    isAuthenticated = Boolean(data?.authenticated);
  } catch {
    isAuthenticated = false;
  }

  if (isAuthenticated) {
    $("modalOverlay").classList.remove("show");
    loadAll();
    startPoll();
  } else {
    $("modalOverlay").classList.add("show");
  }
}

async function apiFetch(path, signal) {
  const r = await fetch(`${API_BASE}${path}`, { cache: "no-store", signal });
  if (r.status === 401) {
    isAuthenticated = false;
    $("modalOverlay").classList.add("show");
    throw new Error("Unauthorized");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function renderSummaryPanels() {
  renderStatsExtended(latestStatusData);
  renderOverview(latestStatusData, latestWhitelistData, latestRecentData);
  renderLastCronResult(latestStatusData, false);
  renderSourceHealth(latestStatusData);
  renderDerivedInsights();
}

async function loadLightData() {
  if (!checkAuth()) return;

  if (lightAbortController) lightAbortController.abort();
  const controller = new AbortController();
  lightAbortController = controller;

  try {
    const [statusR, recentR] = await Promise.allSettled([
      apiFetch("/api/status", controller.signal),
      apiFetch("/api/recent", controller.signal),
    ]);

    if (lightAbortController !== controller) return;

    if (statusR.status === "fulfilled") {
      latestStatusData = statusR.value;
      renderSummaryPanels();
    } else if (statusR.reason?.name !== "AbortError" && !latestStatusData) {
      renderSummaryPanels();
    }

    if (recentR.status === "fulfilled") {
      latestRecentData = recentR.value;
      renderRecent(latestRecentData);
      renderSummaryPanels();
    } else if (recentR.reason?.name !== "AbortError" && !latestRecentData) {
      renderErr($("recentList"), "Gagal muat recent data");
    }

    $("lastUpdated").textContent = `diperbarui ${fmt(new Date())}`;
    lastLightLoadAt = Date.now();
  } finally {
    if (lightAbortController === controller) lightAbortController = null;
  }
}

async function loadHeavyData() {
  if (!checkAuth()) return;

  if (heavyAbortController) heavyAbortController.abort();
  const controller = new AbortController();
  heavyAbortController = controller;

  try {
    const [whitelistR, logsR, compareR] = await Promise.allSettled([
      apiFetch("/api/whitelist", controller.signal),
      apiFetch("/api/logs", controller.signal),
      apiFetch("/api/source-compare", controller.signal),
    ]);

    if (heavyAbortController !== controller) return;

    if (whitelistR.status === "fulfilled") {
      latestWhitelistData = whitelistR.value;
      renderWhitelist(latestWhitelistData);
      renderSummaryPanels();
    } else if (whitelistR.reason?.name !== "AbortError" && !latestWhitelistData) {
      renderErr($("mangaList"), "Gagal muat whitelist");
    }

    if (logsR.status === "fulfilled") {
      renderLogs(logsR.value);
    } else if (logsR.reason?.name !== "AbortError") {
      renderErr($("logList"), "Gagal muat logs");
    }

    if (compareR.status === "fulfilled") {
      renderSourceCompare(compareR.value);
    } else if (compareR.reason?.name !== "AbortError") {
      renderErr($("compareList"), "Gagal muat source compare");
    }

    lastHeavyLoadAt = Date.now();
    $("lastUpdated").textContent = `diperbarui ${fmt(new Date())}`;
  } finally {
    if (heavyAbortController === controller) heavyAbortController = null;
  }
}

async function loadAll() {
  if (!checkAuth()) return;
  clearAlert();

  if (lightAbortController) lightAbortController.abort();
  if (heavyAbortController) heavyAbortController.abort();
  if (loadAbortController) loadAbortController.abort();
  const controller = new AbortController();
  loadAbortController = controller;

  const btn = $("btnRefresh");
  btn.disabled = true;
  btn.textContent = "memuat...";

  skeleton($("mangaList"), 5);
  skeletonRecent($("recentList"), 4);
  skeleton($("logList"), 6);
  skeleton($("compareList"), 4);
  skeleton($("sourceHealthList"), 3);
  skeleton($("topTitlesList"), 4);
  skeleton($("compareLeaderboardList"), 4);
  skeleton($("whitelistLastSeenList"), 4);
  skeleton($("missedDetectorList"), 4);
  skeleton($("sourceReliabilityList"), 3);
  skeleton($("failedMonitorList"), 3);
  skeleton($("sourceMixList"), 3);

  try {
    const [statusR, whitelistR, recentR, logsR, compareR] = await Promise.allSettled([
      apiFetch("/api/status", controller.signal),
      apiFetch("/api/whitelist", controller.signal),
      apiFetch("/api/recent", controller.signal),
      apiFetch("/api/logs", controller.signal),
      apiFetch("/api/source-compare", controller.signal),
    ]);

    if (loadAbortController !== controller) return;

    const statusData = statusR.status === "fulfilled" ? statusR.value : null;
    const whitelistData = whitelistR.status === "fulfilled" ? whitelistR.value : null;
    const recentData = recentR.status === "fulfilled" ? recentR.value : null;
    const logsData = logsR.status === "fulfilled" ? logsR.value : null;
    const compareData = compareR.status === "fulfilled" ? compareR.value : null;

    latestStatusData = statusData;
    latestWhitelistData = whitelistData;
    latestRecentData = recentData;
    renderSummaryPanels();

    if (whitelistData) renderWhitelist(whitelistData);
    else renderErr($("mangaList"), "Gagal muat whitelist");

    if (recentData) renderRecent(recentData);
    else renderErr($("recentList"), "Gagal muat recent data");

    if (logsData) renderLogs(logsData);
    else renderErr($("logList"), "Gagal muat logs");

    if (compareData) renderSourceCompare(compareData);
    else renderErr($("compareList"), "Gagal muat source compare");

    const anyFailed = [statusR, whitelistR, recentR, logsR, compareR].some(
      (r) => r.status === "rejected" && r.reason?.name !== "AbortError",
    );
    if (anyFailed && isAuthenticated) {
      showAlert("Beberapa endpoint gagal dimuat. Coba refresh lagi.");
    }

    lastHeavyLoadAt = Date.now();
    $("lastUpdated").textContent = `diperbarui ${fmt(new Date())}`;
    renderTrendChart();
    renderSourceChart();
  } finally {
    if (loadAbortController === controller) loadAbortController = null;
    btn.disabled = false;
    btn.textContent = "refresh";
  }
}

function startPoll() {
  clearInterval(lightPollTimer);
  clearInterval(heavyPollTimer);
  if (!autoRefreshEnabled) return;
  lightPollTimer = setInterval(() => {
    if (!isProcessing) loadLightData();
  }, currentLightPollMs());
  heavyPollTimer = setInterval(() => {
    if (!isProcessing) loadHeavyData();
  }, currentHeavyPollMs());
}

function updateAutoRefreshUI() {
  const btn = $("btnAutoRefresh");
  const select = $("pollInterval");
  const pollInfo = $("pollInfo");
  if (select) select.value = String(pollMs);
  if (btn) btn.textContent = autoRefreshEnabled ? "auto: on" : "auto: off";
  if (pollInfo) {
    if (!autoRefreshEnabled) {
      pollInfo.textContent = "light: off | heavy: off";
      return;
    }
    const hiddenSuffix = document.hidden ? " | bg: hemat" : "";
    pollInfo.textContent =
      `light: ${msToSecondsLabel(currentLightPollMs())} | heavy: ${msToSecondsLabel(currentHeavyPollMs())}${hiddenSuffix}`;
  }
}

function toggleAutoRefresh() {
  autoRefreshEnabled = !autoRefreshEnabled;
  localStorage.setItem("ikiru_auto_refresh", autoRefreshEnabled ? "on" : "off");
  updateAutoRefreshUI();
  startPoll();
}

function setPollInterval() {
  const select = $("pollInterval");
  if (!select) return;
  const next = Number(select.value);
  if (!ALLOWED_POLL_MS.includes(next)) return;
  pollMs = next;
  localStorage.setItem("ikiru_poll_ms", String(pollMs));
  updateAutoRefreshUI();
  startPoll();
}

window.addEventListener("focus", () => {
  if (!isAuthenticated || isProcessing) return;
  const now = Date.now();
  if (now - lastFocusRefreshAt < FOCUS_REFRESH_COOLDOWN_MS) return;
  lastFocusRefreshAt = now;

  if (now - lastLightLoadAt > Math.min(currentLightPollMs(), FOCUS_REFRESH_COOLDOWN_MS)) {
    loadLightData();
  }
  if (now - lastHeavyLoadAt > currentHeavyPollMs() / 2) {
    loadHeavyData();
  }
});

document.addEventListener("visibilitychange", () => {
  updateAutoRefreshUI();
  startPoll();
});

function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  $("btnTheme").textContent = dark ? "dark" : "light";
  renderTrendChart();
  renderSourceChart();
}

function toggleTheme() {
  const isDark = !document.body.classList.contains("dark");
  localStorage.setItem("ikiru_theme", isDark ? "dark" : "light");
  applyTheme(isDark);
}

applyTheme(localStorage.getItem("ikiru_theme") === "dark");
updateAutoRefreshUI();
bootstrapAuth();

window.copyUrl = copyUrl;
window.quickCheckMatch = quickCheckMatch;
window.renderTrendChart = renderTrendChart;
