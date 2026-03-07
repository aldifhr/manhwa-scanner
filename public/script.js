const API_BASE = "";
const POLL_MS = 30_000;
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
let secret = localStorage.getItem("ikiru_secret") || "";
let pollTimer = null;
let trendChart = null;
let isProcessing = false;
let loadAbortController = null;
let latestLogs = [];

// ===== WHITELIST STATE =====
let whitelistItems = [];
let whitelistSortOrder = "default"; // default | az | za

// ===== CHART =====
async function renderSuccessChart(data) {
  const canvas = $("trendChart");
  if (!canvas) return;
  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }

  const ctx = canvas.getContext("2d");
  trendChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.labels || [],
      datasets: [
        {
          label: "Sent ✅",
          data: data.sent || [],
          backgroundColor: "#10B981",
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: "Failed ❌",
          data: data.failed || [],
          backgroundColor: "#EF4444",
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      scales: {
        y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.05)" } },
        x: { grid: { display: false } },
      },
      plugins: {
        legend: { position: "top", labels: { padding: 16, boxWidth: 12 } },
        title: { display: false },
      },
      animation: { duration: 600 },
    },
  });
}

// ===== UPTIME & TOP =====
function calculateUptime(logs, hours) {
  if (!logs?.length) return null;
  const cutoff = Date.now() - hours * 3600000;
  const recent = logs.filter((l) => new Date(l.time) > cutoff);
  if (!recent.length) return null;
  return Math.round(
    (recent.filter((l) => l.tag === "sent").length / recent.length) * 100,
  );
}

function getTopManhwa(logs) {
  const counter = {};
  logs
    ?.filter((l) => l.tag === "sent" && l.message?.includes("Chapter"))
    .forEach((l) => {
      const title =
        l.message.split(" — ")[0]?.trim() ||
        l.message.split("Chapter")[0]?.trim();
      if (title) counter[title] = (counter[title] || 0) + 1;
    });
  return Object.entries(counter)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([title, count]) => ({ title, count }));
}

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
  localStorage.setItem("ikiru_secret", val);
  $("modalOverlay").classList.remove("show");
  loadAll();
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
    localStorage.removeItem("ikiru_secret");
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
  if (!iso) return "—";
  const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
  const intervals = [
    { label: "h", seconds: 86400 },
    { label: "j", seconds: 3600 },
    { label: "m", seconds: 60 },
    { label: "dtk", seconds: 1 },
  ];
  for (const i of intervals) {
    const value = Math.floor(seconds / i.seconds);
    if (value >= 1) return `${value}${i.label} lalu`;
  }
  return "baru saja";
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
function renderStatsExtended(statusData, uptimeData) {
  const dot = $("statusDot");
  if (!statusData) {
    [
      "statSent",
      "statSkipped",
      "statFailed",
      "statDuration",
      "statUptime24h",
      "statUptime7d",
    ].forEach((id) => ($(id).textContent = "—"));
    dot.className = "logo-dot offline";
    return;
  }
  $("statSent").textContent = statusData.sent ?? "—";
  $("statSkipped").textContent = statusData.skipped ?? "—";
  $("statFailed").textContent = statusData.failed ?? "—";
  $("statDuration").textContent = statusData.duration
    ? `${statusData.duration}s`
    : "—";
  $("statUptime24h").textContent = uptimeData?.uptime24h ?? "—";
  $("statUptime24h").className =
    `stat-value ${uptimeData?.uptime24h >= 95 ? "green" : uptimeData?.uptime24h >= 80 ? "amber" : "red"}`;
  $("statUptime7d").textContent = uptimeData?.uptime7d ?? "—";
  $("statUptime7d").className =
    `stat-value ${uptimeData?.uptime7d >= 95 ? "green" : uptimeData?.uptime7d >= 80 ? "amber" : "red"}`;
  dot.className = "logo-dot" + (statusData.failed > 0 ? " offline" : "");
}

function renderOverview(statusData, whitelistData, guildData, recentData) {
  const healthEl = $("overviewHealth");
  const lastRunEl = $("overviewLastRun");
  const guildsEl = $("overviewGuilds");
  const whitelistEl = $("overviewWhitelist");
  const sent24hEl = $("overviewSent24h");

  if (!statusData) {
    healthEl.textContent = "—";
    lastRunEl.textContent = "—";
    guildsEl.textContent = "—";
    whitelistEl.textContent = "—";
    sent24hEl.textContent = "—";
    healthEl.className = "stat-value";
    return;
  }

  const failed = Number(statusData.failed ?? 0);
  healthEl.textContent = failed > 0 ? "DEGRADED" : "HEALTHY";
  healthEl.className = `stat-value ${failed > 0 ? "amber" : "green"}`;

  lastRunEl.textContent = statusData.timestamp ? timeAgo(statusData.timestamp) : "—";
  guildsEl.textContent = Array.isArray(guildData?.guilds) ? guildData.guilds.length : "—";
  whitelistEl.textContent = Array.isArray(whitelistData?.items)
    ? whitelistData.items.length
    : "—";
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
    sentEl.textContent = "sent: —";
    skippedEl.textContent = "skipped: —";
    failedEl.textContent = "failed: —";
    durationEl.textContent = "duration: —";
    timeEl.textContent = "—";
    bar.className = "last-cron-bar";
    return;
  }

  const sent = Number(statusData.sent ?? 0);
  const skipped = Number(statusData.skipped ?? 0);
  const failed = Number(statusData.failed ?? 0);
  const duration = statusData.duration ? `${statusData.duration}s` : "—";

  sentEl.textContent = `sent: ${sent}`;
  skippedEl.textContent = `skipped: ${skipped}`;
  failedEl.textContent = `failed: ${failed}`;
  durationEl.textContent = `duration: ${duration}`;

  const sourceText = fromManual ? "manual" : "auto";
  const timeText = statusData.timestamp ? timeAgo(statusData.timestamp) : "baru saja";
  timeEl.textContent = `${sourceText} • ${timeText}`;

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
      : `<li class="empty">Whitelist kosong — tambah manga di atas</li>`;
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
        ${url ? `<span class="manga-item-has-url" title="${esc(url)}">🔗</span>` : ""}
        <button class="btn-delete" onclick="deleteManga('${esc(title)}')">✕</button>
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

function renderTopManhwa(data) {
  const list = $("topManhwaList");
  const top = data?.top ?? [];
  $("topCount").textContent = top.length;
  if (!top.length) {
    list.innerHTML = '<li class="empty">Belum ada chapter terkirim</li>';
    return;
  }
  list.innerHTML = top
    .map(
      (item, i) =>
        `<li class="manga-item">
      <span class="manga-index">${String(i + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(item.title)}</span>
      <span class="top-count">${item.count}×</span>
    </li>`,
    )
    .join("");
}

function renderGuilds(data) {
  const list = $("guildList");
  const guilds = data?.guilds ?? [];
  $("guildCount").textContent = guilds.length;
  if (!guilds.length) {
    list.innerHTML = `<li class="empty">Belum ada guild</li>`;
    return;
  }
  list.innerHTML = guilds
    .map(
      (g) =>
        `<li class="guild-item">
      <div class="guild-info">
        <div class="guild-id">${esc(g.guildName || g.guildId)}</div>
        <div class="guild-channel">#${esc(g.channelName || g.channelId)}</div>
      </div>
      <span class="status-pill ${g.channelId ? "active" : "invalid"}">${g.channelId ? "aktif" : "invalid"}</span>
    </li>`,
    )
    .join("");
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
          `<div class="recent-cover-placeholder" style="display:none">📖</div>`
        : `<div class="recent-cover-placeholder">📖</div>`;
      return `<a class="recent-item" href="${item.url ? esc(item.url) : "#"}" target="_blank" rel="noopener">
      ${cover}
      <div class="recent-info">
        <div class="recent-title">${esc(item.title)}</div>
        <div class="recent-chapter">${esc(item.chapter)}</div>
      </div>
      <span class="recent-time">${item.sentAt ? timeAgo(item.sentAt) : "—"}</span>
    </a>`;
    })
    .join("");
}

function renderLogs(data) {
  const list = $("logList");
  const logs = data?.logs ?? [];
  latestLogs = logs;
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

function openLogDrilldown() {
  const overlay = $("logDrilldownOverlay");
  const list = $("logDrilldownList");
  const logs = (latestLogs || []).slice(0, 20);

  if (!logs.length) {
    list.innerHTML = `<li class="empty">Belum ada log</li>`;
  } else {
    list.innerHTML = logs
      .map(
        (l) => `
      <li class="log-item">
        <span class="log-time">${fmt(new Date(l.time))}</span>
        <span>${esc(l.message)}</span>
        <span class="log-tag ${esc(l.tag)}">${esc(l.tag)}</span>
      </li>`,
      )
      .join("");
  }

  overlay.classList.add("show");
}

function closeLogDrilldown() {
  $("logDrilldownOverlay").classList.remove("show");
}

function renderSnapshots(snapshots) {
  const list = $("snapshotList");
  $("snapshotCount").textContent = snapshots.length;
  if (!snapshots.length) {
    list.innerHTML = `<li class="empty">Belum ada snapshot</li>`;
    return;
  }
  list.innerHTML = snapshots
    .map(
      (s) => `
    <li class="manga-item">
      <span class="manga-index">📸</span>
      <span class="manga-item-title">
        ${esc(s.label || "Snapshot")}
        <small style="opacity:.5;font-size:.75em;margin-left:6px">${s.count} manga · ${timeAgo(s.savedAt)}</small>
      </span>
      <button class="btn-delete" style="background:var(--green,#22c55e);color:#fff;margin-right:4px"
        onclick="restoreSnapshot('${s.id}', '${esc(s.label || s.id)}')">↩ restore</button>
      <button class="btn-delete" onclick="deleteSnapshot('${s.id}')">✕</button>
    </li>
  `,
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

async function runMatchTest() {
  if (!checkAuth() || isProcessing) return;

  const title = $("matchTestTitle")?.value.trim() || "";
  const url = $("matchTestUrl")?.value.trim() || "";
  const btn = $("btnMatchTest");
  const out = $("matchTestResult");

  if (!title && !url) {
    out.innerHTML = `<span style="color:var(--red)">Isi minimal title atau URL.</span>`;
    return;
  }

  isProcessing = true;
  btn.disabled = true;
  btn.textContent = "testing...";
  out.innerHTML = "Testing matcher...";

  try {
    const r = await fetch(`${API_BASE}/api/test-match`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, url }),
    });
    const data = await r.json();
    if (!r.ok) {
      out.innerHTML = `<span style="color:var(--red)">${esc(data.error || "Request gagal")}</span>`;
      return;
    }

    const sample = (data.sample || [])
      .slice(0, 5)
      .map((x) => `• ${esc(x.title)} — ${esc(x.chapter)}`)
      .join("<br>");

    out.innerHTML = `
      <div><strong>Scraped:</strong> ${data.scraped} | <strong>Matched:</strong> ${data.matched}</div>
      <div><strong>By URL:</strong> ${data.diagnostics?.byUrlCount ?? 0} | <strong>By Title:</strong> ${data.diagnostics?.byTitleCount ?? 0}</div>
      <div style="margin-top:6px">${sample || "Tidak ada sample match."}</div>
    `;
  } catch (e) {
    out.innerHTML = `<span style="color:var(--red)">Gagal: ${esc(e.message)}</span>`;
  } finally {
    isProcessing = false;
    btn.disabled = false;
    btn.textContent = "Test";
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
  skeleton($("guildList"), 3);
  skeletonRecent($("recentList"), 4);
  skeleton($("logList"), 5);
  skeleton($("topManhwaList"));
  skeleton($("snapshotList"), 2);

  try {
    const [
      statusR,
      whitelistR,
      guildsR,
      recentR,
      logsR,
      uptimeR,
      topR,
      trendR,
      snapshotR,
    ] = await Promise.allSettled([
      apiFetch("/api/status", controller.signal),
      apiFetch("/api/whitelist", controller.signal),
      apiFetch("/api/guilds", controller.signal),
      apiFetch("/api/recent", controller.signal),
      apiFetch("/api/logs", controller.signal),
      apiFetch("/api/uptime", controller.signal),
      apiFetch("/api/top", controller.signal),
      fetch(`${API_BASE}/api/chart`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${secret}` },
        signal: controller.signal,
      }),
      apiFetch("/api/snapshot", controller.signal),
    ]);

    if (loadAbortController !== controller) return;

    renderStatsExtended(
      statusR.status === "fulfilled" ? statusR.value : null,
      uptimeR.status === "fulfilled" ? uptimeR.value : null,
    );
    renderOverview(
      statusR.status === "fulfilled" ? statusR.value : null,
      whitelistR.status === "fulfilled" ? whitelistR.value : null,
      guildsR.status === "fulfilled" ? guildsR.value : null,
      recentR.status === "fulfilled" ? recentR.value : null,
    );
    renderLastCronResult(
      statusR.status === "fulfilled" ? statusR.value : null,
      false,
    );

    if (trendR.status === "fulfilled" && trendR.value.ok) {
      try {
        renderSuccessChart(await trendR.value.json());
      } catch (e) {
        console.error("Chart error:", e);
      }
    }

    if (topR.status === "fulfilled") renderTopManhwa(topR.value);
    else renderErr($("topManhwaList"), "Gagal muat");

    if (whitelistR.status === "fulfilled") renderWhitelist(whitelistR.value);
    else renderErr($("mangaList"), "Gagal muat whitelist");

    if (guildsR.status === "fulfilled") renderGuilds(guildsR.value);
    else renderErr($("guildList"), "Gagal muat guilds");

    if (recentR.status === "fulfilled") renderRecent(recentR.value);
    else renderErr($("recentList"), "Gagal muat");

    if (logsR.status === "fulfilled") renderLogs(logsR.value);
    else renderErr($("logList"), "Gagal muat logs");

    if (snapshotR.status === "fulfilled") renderSnapshots(snapshotR.value.snapshots ?? []);
    else renderErr($("snapshotList"), "Gagal muat snapshot");

    const anyFailed = [
      statusR, whitelistR, guildsR, recentR, logsR, uptimeR, topR, trendR, snapshotR,
    ].some((r) => r.status === "rejected" && r.reason?.name !== "AbortError");
    if (anyFailed && secret) showAlert("Beberapa data gagal dimuat.");

    $("lastUpdated").textContent = `updated ${fmt(new Date())}`;
  } finally {
    if (loadAbortController === controller) loadAbortController = null;
    btn.disabled = false;
    btn.textContent = "↻ refresh";
  }
}

// ===== SNAPSHOT RELOAD =====
async function reloadSnapshots() {
  try {
    const data = await apiFetch("/api/snapshot");
    renderSnapshots(data.snapshots ?? []);
  } catch (e) {
    renderErr($("snapshotList"), "Gagal muat snapshot");
  }
}

// ===== POLL + FOCUS =====
function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(loadAll, POLL_MS);
}

window.addEventListener("focus", () => {
  if (secret && !isProcessing) loadAll();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLogDrilldown();
});

// ===== THEME =====
function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  $("btnTheme").textContent = dark ? "🌙" : "☀️";
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

// ===== SNAPSHOT ACTIONS =====
async function saveSnapshot() {
  const labelInput = $("inputSnapshotLabel");
  const btn = $("btnSaveSnapshot");
  const label = labelInput.value.trim();

  isProcessing = true;
  btn.disabled = true;
  btn.textContent = "...";

  try {
    const r = await fetch(`${API_BASE}/api/snapshot`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: label || null }),
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Gagal save snapshot");
      return;
    }
    labelInput.value = "";
    showAlert(
      `✅ Snapshot "${data.snapshot.label || data.snapshot.id}" tersimpan! (${data.snapshot.count} manga)`,
    );
    reloadSnapshots();
  } catch (e) {
    showAlert("Gagal: " + e.message);
  } finally {
    isProcessing = false;
    btn.disabled = false;
    btn.textContent = "📸 Save";
  }
}

async function restoreSnapshot(id, label) {
  if (
    !confirm(
      `Restore snapshot "${label}"?\n\nWhitelist aktif akan diganti. Whitelist saat ini akan di-backup otomatis.`,
    )
  )
    return;

  isProcessing = true;
  try {
    const r = await fetch(`${API_BASE}/api/snapshot`, {
      method: "PUT",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id }),
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Gagal restore");
      return;
    }
    showAlert(`✅ ${data.message}`);
    reloadSnapshots();
    apiFetch("/api/whitelist").then(renderWhitelist).catch(() => {});
  } catch (e) {
    showAlert("Gagal: " + e.message);
  } finally {
    isProcessing = false;
  }
}

async function deleteSnapshot(id) {
  if (!confirm("Hapus snapshot ini?")) return;
  isProcessing = true;
  try {
    const r = await fetch(`${API_BASE}/api/snapshot`, {
      method: "DELETE",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id }),
    });
    const data = await r.json();
    if (!r.ok) {
      showAlert(data.error || "Gagal hapus snapshot");
      return;
    }
    reloadSnapshots();
  } catch (e) {
    showAlert("Gagal: " + e.message);
  } finally {
    isProcessing = false;
  }
}
