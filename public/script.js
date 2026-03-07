const API_BASE = "";
const SECRET_STORAGE_KEY = "ikiru_secret";
const DEFAULT_POLL_MS = 30_000;
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
const legacySecret = localStorage.getItem(SECRET_STORAGE_KEY) || "";
if (legacySecret && !sessionStorage.getItem(SECRET_STORAGE_KEY)) {
  sessionStorage.setItem(SECRET_STORAGE_KEY, legacySecret);
}
localStorage.removeItem(SECRET_STORAGE_KEY);

let secret = sessionStorage.getItem(SECRET_STORAGE_KEY) || "";
let pollTimer = null;
let pollMs = Number(localStorage.getItem("ikiru_poll_ms") || DEFAULT_POLL_MS);
if (![10_000, 30_000, 60_000].includes(pollMs)) pollMs = DEFAULT_POLL_MS;
let autoRefreshEnabled = localStorage.getItem("ikiru_auto_refresh") !== "off";
let isProcessing = false;
let loadAbortController = null;

// ===== WHITELIST STATE =====
let whitelistItems = [];
let whitelistSortOrder = "default"; // default | az | za

function countSentLast24h(recentItems) {
  if (!Array.isArray(recentItems)) return 0;
  const cutoff = Date.now() - 24 * 3600000;
  return recentItems.filter((item) => {
    if (!item?.sentAt) return false;
    const t = new Date(item.sentAt).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  }).length;
}

// ===== AUTH =====
function checkAuth() {
  if (!secret) {
    $("modalOverlay").classList.add("show");
    return false;
  }
  return true;
}
function submitSecret() {
  const val = $("secretInput").value.trim();
  if (!val) return;
  secret = val;
  sessionStorage.setItem(SECRET_STORAGE_KEY, val);
  $("modalOverlay").classList.remove("show");
  loadAll();
  startPoll();
}
$("secretInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitSecret();
});

async function apiFetch(path, signal) {
  const r = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${secret}` },
    signal,
  });
  if (r.status === 401) {
    secret = "";
    sessionStorage.removeItem(SECRET_STORAGE_KEY);
    localStorage.removeItem(SECRET_STORAGE_KEY);
    $("modalOverlay").classList.add("show");
    throw new Error("Unauthorized");
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ===== UI HELPERS =====
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (d) => TIME_FORMATTER.format(d);
function timeAgo(iso) {
  if (!iso) return "-";
  const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
  const intervals = [
    { label: "hari", seconds: 86400 },
    { label: "jam", seconds: 3600 },
    { label: "menit", seconds: 60 },
    { label: "detik", seconds: 1 },
  ];
  for (const i of intervals) {
    const value = Math.floor(seconds / i.seconds);
    if (value >= 1) return `${value} ${i.label} lalu`;
  }
  return "baru saja";
}

function sourceName(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "shinigami_project" || s === "shinigami_mirror" || s === "shinigami") {
    return "Shinigami";
  }
  return "Ikiru";
}

function skeleton(ul, n = 4) {
  ul.innerHTML = Array.from(
    { length: n },
    (_, i) =>
      `<li style="padding:9px 16px;border-bottom:1px solid var(--border)">
      <div class="skel" style="width:${50 + (i % 3) * 20}%"></div>
    </li>`,
  ).join("");
}
function skeletonRecent(ul, n = 4) {
  ul.innerHTML = Array.from(
    { length: n },
    () =>
      `<li style="display:grid;grid-template-columns:36px 1fr auto;gap:10px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--border)">
      <div style="width:36px;height:50px;border-radius:3px;background:var(--border)"></div>
      <div>
        <div class="skel" style="width:65%;margin-bottom:5px"></div>
        <div class="skel" style="width:35%"></div>
      </div>
    </li>`,
  ).join("");
}
function showAlert(msg) {
  const el = $("alertBox");
  el.style.display = "block";
  el.textContent = msg;
  setTimeout(() => (el.style.display = "none"), 8000);
}
function clearAlert() {
  $("alertBox").style.display = "none";
}
function renderErr(ul, msg) {
  ul.innerHTML = `<li class="empty" style="color:var(--red)">${msg}</li>`;
}

// highlight query dalam teks
function highlight(text, query) {
  if (!query) return esc(text);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  return esc(text).replace(re, `<mark style="background:var(--amber-bg);color:var(--amber);border-radius:2px;padding:0 1px">$1</mark>`);
}

// ===== RENDER =====
function renderStatsExtended(statusData) {
  const dot = $("statusDot");
  if (!statusData) {
    [
      "statSent",
      "statSkipped",
      "statFailed",
      "statDuration",
    ].forEach((id) => ($(id).textContent = "-"));
    dot.className = "logo-dot offline";
    return;
  }
  $("statSent").textContent = statusData.sent ?? "-";
  $("statSkipped").textContent = statusData.skipped ?? "-";
  $("statFailed").textContent = statusData.failed ?? "-";
  $("statDuration").textContent = statusData.duration
    ? `${statusData.duration}s`
    : "-";
  dot.className = "logo-dot" + (statusData.failed > 0 ? " offline" : "");
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

  const failed = Number(statusData.failed ?? 0);
  healthEl.textContent = failed > 0 ? "DEGRADED" : "HEALTHY";
  healthEl.className = `stat-value ${failed > 0 ? "amber" : "green"}`;

  lastRunEl.textContent = statusData.timestamp ? timeAgo(statusData.timestamp) : "-";
  whitelistEl.textContent = Array.isArray(whitelistData?.items)
    ? whitelistData.items.length
    : "-";
  sent24hEl.textContent = countSentLast24h(recentData?.items);
}

function renderLastCronResult(statusData, fromManual = false) {
  const bar = $("lastCronBar");
  const timeEl = $("lastCronTime");
  const sentEl = $("lastCronSent");
  const skippedEl = $("lastCronSkipped");
  const failedEl = $("lastCronFailed");
  const durationEl = $("lastCronDuration");

  if (!statusData) {
    sentEl.textContent = "sent: -";
    skippedEl.textContent = "skipped: -";
    failedEl.textContent = "failed: -";
    durationEl.textContent = "duration: -";
    timeEl.textContent = "-";
    bar.className = "last-cron-bar";
    return;
  }

  const sent = Number(statusData.sent ?? 0);
  const skipped = Number(statusData.skipped ?? 0);
  const failed = Number(statusData.failed ?? 0);
  const duration = statusData.duration ? `${statusData.duration}s` : "-";

  sentEl.textContent = `sent: ${sent}`;
  skippedEl.textContent = `skipped: ${skipped}`;
  failedEl.textContent = `failed: ${failed}`;
  durationEl.textContent = `duration: ${duration}`;

  const sourceText = fromManual ? "manual" : "otomatis";
  const timeText = statusData.timestamp ? timeAgo(statusData.timestamp) : "baru saja";
  timeEl.textContent = `${sourceText} - ${timeText}`;

  bar.className = `last-cron-bar ${failed > 0 ? "warn" : "ok"}`;
}

// ===== WHITELIST RENDER + FILTER =====
function applyWhitelistFilter() {
  const query = ($("inputWhitelistSearch")?.value ?? "").trim().toLowerCase();
  const list = $("mangaList");
  const items = whitelistItems.map((item, originalIndex) => {
    const title = typeof item === "string" ? item : item.title;
    return { item, title, titleLower: title.toLowerCase(), originalIndex };
  });

  if (whitelistSortOrder === "az") {
    items.sort((a, b) => a.titleLower.localeCompare(b.titleLower));
  } else if (whitelistSortOrder === "za") {
    items.sort((a, b) => b.titleLower.localeCompare(a.titleLower));
  }

  const filtered = query ? items.filter((entry) => entry.titleLower.includes(query)) : items;

  // update badge
  $("whitelistCount").textContent = whitelistItems.length;

  if (!filtered.length) {
    list.innerHTML = query
      ? `<li class="empty">Tidak ada hasil untuk "<strong>${esc(query)}</strong>"</li>`
      : `<li class="empty">Whitelist kosong - tambah manga di atas</li>`;
    return;
  }

  list.innerHTML = filtered
    .map((entry, i) => {
      const { item, title, originalIndex } = entry;
      const url = typeof item === "object" ? item.url : null;
      const displayIndex = whitelistSortOrder === "default" ? originalIndex : i;
      return `<li class="manga-item" title="${url ? esc(url) : ""}">
        <span class="manga-index">${String(displayIndex + 1).padStart(2, "0")}</span>
        <span class="manga-item-title">${highlight(title, query)}</span>
        ${url ? `<span class="manga-item-has-url" title="${esc(url)}">link</span>` : ""}
        <button class="btn-delete" onclick="deleteManga('${esc(title)}')">x</button>
      </li>`;
    })
    .join("");
}

function renderWhitelist(data) {
  whitelistItems = data?.items ?? [];
  applyWhitelistFilter();
}

function setSortOrder(order) {
  whitelistSortOrder = order;
  // update tombol aktif
  ["default", "az", "za"].forEach((o) => {
    const btn = $(`sortBtn_${o}`);
    if (btn) btn.classList.toggle("active", o === order);
  });
  applyWhitelistFilter();
}

function renderRecent(data) {
  const list = $("recentList");
  const items = data?.items ?? [];
  $("recentCount").textContent = items.length;
  if (!items.length) {
    list.innerHTML = `<li class="empty">Belum ada chapter terkirim</li>`;
    return;
  }
  list.innerHTML = items
    .map((item) => {
      const cover = item.cover
        ? `<img class="recent-cover" src="${esc(item.cover)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` +
          `<div class="recent-cover-placeholder" style="display:none">img</div>`
        : `<div class="recent-cover-placeholder">img</div>`;
      return `<a class="recent-item" href="${item.url ? esc(item.url) : "#"}" target="_blank" rel="noopener">
      ${cover}
      <div class="recent-info">
        <div class="recent-title">${esc(item.title)}</div>
        <div class="recent-chapter">${esc(item.chapter)}${item.source ? ` - ${esc(sourceName(item.source))}` : ""}</div>
      </div>
      <span class="recent-time">${item.sentAt ? timeAgo(item.sentAt) : "-"}</span>
    </a>`;
    })
    .join("");
}

function renderSourceCompare(data) {
  const summary = data?.summary ?? {};
  const sourceCounts = data?.sourceCounts ?? {};
  const items = data?.comparisons ?? [];
  const list = $("compareList");

  $("compareCount").textContent = summary.totalCompared ?? 0;
  $("compareIkiruWins").textContent = summary.ikiruWins ?? 0;
  $("compareShinigamiWins").textContent = summary.shinigamiWins ?? 0;
  $("compareTies").textContent = summary.ties ?? 0;
  $("sourceCountIkiru").textContent = sourceCounts.ikiru ?? 0;
  $("sourceCountShinigami").textContent =
    (sourceCounts.shinigami_project ?? 0) + (sourceCounts.shinigami_mirror ?? 0);

  if (!items.length) {
    list.innerHTML = '<li class="empty">Belum ada data compare judul/chapter yang sama.</li>';
    return;
  }

  list.innerHTML = items
    .map((item, i) => {
      const winnerText =
        item.winner === "ikiru"
          ? "Ikiru lebih cepat"
          : item.winner === "shinigami"
            ? "Shinigami lebih cepat"
            : "Tie";
      const delta = Number(item.deltaMinutes ?? 0);
      return `<li class="manga-item">
      <span class="manga-index">${String(i + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.title)} - ${esc(item.chapter)}
      <small style="display:block;opacity:.6;font-size:.75em">${esc(winnerText)} (${delta} menit)</small></span>
    </li>`;
    })
    .join("");
}

function renderLogs(data) {
  const list = $("logList");
  const logs = data?.logs ?? [];
  $("logCount").textContent = `${logs.length} entries`;
  if (!logs.length) {
    list.innerHTML = `<li class="empty">Belum ada log</li>`;
    return;
  }
  list.innerHTML = logs
    .map(
      (l) =>
        `<li class="log-item">
      <span class="log-time">${fmt(new Date(l.time))}</span>
      <span>${esc(l.message)}</span>
      <span class="log-tag ${esc(l.tag)}">${esc(l.tag)}</span>
    </li>`,
    )
    .join("");
}

// ===== WHITELIST ADD/DELETE =====
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
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
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
  } catch (e) {
    showAlert("Gagal: " + e.message);
  } finally {
    isProcessing = false;
    btn.disabled = false;
    btn.textContent = "+ Tambah";
  }
}

async function deleteManga(title) {
  if (!confirm(`Hapus "${title}"?`)) return;
  isProcessing = true;
  try {
    const r = await fetch(`${API_BASE}/api/whitelist`, {
      method: "DELETE",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Gagal menghapus");
      return;
    }
    renderWhitelist(data);
  } catch (e) {
    showAlert("Gagal: " + e.message);
  } finally {
    isProcessing = false;
  }
}

async function runCronNow() {
  if (!checkAuth() || isProcessing) return;

  const btn = $("btnRunCron");
  const oldText = btn?.textContent || "run cron";
  isProcessing = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "running...";
  }

  try {
    const r = await fetch(`${API_BASE}/api/cron`, {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Cron gagal dijalankan");
      return;
    }

    showAlert(
      `Cron selesai: sent ${data.sent ?? 0}, skipped ${data.skipped ?? 0}, failed ${data.failed ?? 0}`,
    );
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
    showAlert("Gagal trigger cron: " + e.message);
  } finally {
    isProcessing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

// ===== LOAD ALL =====
async function loadAll() {
  if (!checkAuth()) return;
  clearAlert();

  if (loadAbortController) loadAbortController.abort();
  const controller = new AbortController();
  loadAbortController = controller;

  const btn = $("btnRefresh");
  btn.disabled = true;
  btn.textContent = "memuat...";

  skeleton($("mangaList"));
  skeletonRecent($("recentList"), 4);
  skeleton($("logList"), 5);
  skeleton($("compareList"), 3);

  try {
    const [
      statusR,
      whitelistR,
      recentR,
      logsR,
      compareR,
    ] = await Promise.allSettled([
      apiFetch("/api/status", controller.signal),
      apiFetch("/api/whitelist", controller.signal),
      apiFetch("/api/recent", controller.signal),
      apiFetch("/api/logs", controller.signal),
      apiFetch("/api/source-compare", controller.signal),
    ]);

    if (loadAbortController !== controller) return;

    renderStatsExtended(statusR.status === "fulfilled" ? statusR.value : null);
    renderOverview(
      statusR.status === "fulfilled" ? statusR.value : null,
      whitelistR.status === "fulfilled" ? whitelistR.value : null,
      recentR.status === "fulfilled" ? recentR.value : null,
    );
    renderLastCronResult(
      statusR.status === "fulfilled" ? statusR.value : null,
      false,
    );

    if (whitelistR.status === "fulfilled") renderWhitelist(whitelistR.value);
    else renderErr($("mangaList"), "Gagal muat whitelist");

    if (recentR.status === "fulfilled") renderRecent(recentR.value);
    else renderErr($("recentList"), "Gagal muat");

    if (logsR.status === "fulfilled") renderLogs(logsR.value);
    else renderErr($("logList"), "Gagal muat logs");

    if (compareR.status === "fulfilled") renderSourceCompare(compareR.value);
    else renderErr($("compareList"), "Gagal muat compare");

    const anyFailed = [
      statusR, whitelistR, recentR, logsR, compareR,
    ].some((r) => r.status === "rejected" && r.reason?.name !== "AbortError");
    if (anyFailed && secret) showAlert("Beberapa data gagal dimuat.");

    $("lastUpdated").textContent = `diperbarui ${fmt(new Date())}`;
  } finally {
    if (loadAbortController === controller) loadAbortController = null;
    btn.disabled = false;
    btn.textContent = "refresh";
  }
}

// ===== POLL + FOCUS =====
function startPoll() {
  clearInterval(pollTimer);
  if (!autoRefreshEnabled) return;
  pollTimer = setInterval(loadAll, pollMs);
}

function updateAutoRefreshUI() {
  const btn = $("btnAutoRefresh");
  const select = $("pollInterval");
  if (select) select.value = String(pollMs);
  if (btn) btn.textContent = autoRefreshEnabled ? "auto: on" : "auto: off";
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
  if (![10_000, 30_000, 60_000].includes(next)) return;
  pollMs = next;
  localStorage.setItem("ikiru_poll_ms", String(pollMs));
  startPoll();
}

window.addEventListener("focus", () => {
  if (secret && !isProcessing) loadAll();
});

// ===== THEME =====
function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  $("btnTheme").textContent = dark ? "dark" : "light";
}
function toggleTheme() {
  const isDark = !document.body.classList.contains("dark");
  localStorage.setItem("ikiru_theme", isDark ? "dark" : "light");
  applyTheme(isDark);
}

// ===== INIT =====
if (secret) {
  loadAll();
  startPoll();
} else $("modalOverlay").classList.add("show");

applyTheme(localStorage.getItem("ikiru_theme") === "dark");
updateAutoRefreshUI();






