const API_BASE = "https://ikiru-bots.vercel.app";
const POLL_MS = 30_000;
const $ = (id) => document.getElementById(id);
let secret = localStorage.getItem("ikiru_secret") || "";
let pollTimer = null;
let trendChart = null;

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

async function apiFetch(path) {
  const r = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${secret}` },
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
const fmt = (d) =>
  new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
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

function renderWhitelist(data) {
  const list = $("mangaList");
  const items = data?.items ?? [];
  $("whitelistCount").textContent = items.length;
  if (!items.length) {
    list.innerHTML = `<li class="empty">Whitelist kosong — tambah manga di atas</li>`;
    return;
  }
  list.innerHTML = items
    .map((item, i) => {
      const title = typeof item === "string" ? item : item.title;
      const url = typeof item === "object" ? item.url : null;
      // URL disembunyikan, hanya muncul sebagai tooltip di title attribute
      return `<li class="manga-item" title="${url ? esc(url) : ""}">
      <span class="manga-index">${String(i + 1).padStart(2, "0")}</span>
      <span class="manga-item-title">${esc(title)}</span>
      ${url ? `<span class="manga-item-has-url" title="${esc(url)}">🔗</span>` : ""}
      <button class="btn-delete" onclick="deleteManga('${esc(title)}')">✕</button>
    </li>`;
    })
    .join("");
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
        <div class="guild-id">${esc(g.guildId)}</div>
        <div class="guild-channel">#${esc(g.channelId)}</div>
      </div>
      <span class="status-pill ${g.valid ? "active" : "invalid"}">${g.valid ? "aktif" : "invalid"}</span>
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
    btn.disabled = false;
    btn.textContent = "+ Tambah";
  }
}

async function deleteManga(title) {
  if (!confirm(`Hapus "${title}"?`)) return;
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
  }
}

// ===== LOAD ALL =====
async function loadAll() {
  if (!checkAuth()) return;
  clearAlert();

  const btn = $("btnRefresh");
  btn.disabled = true;
  btn.textContent = "memuat...";

  skeleton($("mangaList"));
  skeleton($("guildList"), 3);
  skeletonRecent($("recentList"), 4);
  skeleton($("logList"), 5);
  skeleton($("topManhwaList"));

  const [statusR, whitelistR, guildsR, recentR, logsR, uptimeR, topR, trendR] =
    await Promise.allSettled([
      apiFetch("/api/status"),
      apiFetch("/api/whitelist"),
      apiFetch("/api/guilds"),
      apiFetch("/api/recent"),
      apiFetch("/api/logs"),
      apiFetch("/api/uptime"),
      apiFetch("/api/top"),
      fetch(`${API_BASE}/api/chart`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${secret}` },
      }),
    ]);

  renderStatsExtended(
    statusR.status === "fulfilled" ? statusR.value : null,
    uptimeR.status === "fulfilled" ? uptimeR.value : null,
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

  const anyFailed = [
    statusR,
    whitelistR,
    guildsR,
    recentR,
    logsR,
    uptimeR,
    topR,
    trendR,
  ].some((r) => r.status === "rejected");
  if (anyFailed && secret) showAlert("Beberapa data gagal dimuat.");

  $("lastUpdated").textContent = `updated ${fmt(new Date())}`;
  btn.disabled = false;
  btn.textContent = "↻ refresh";
}

// ===== POLL + FOCUS =====
function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(loadAll, POLL_MS);
}
window.addEventListener("focus", () => {
  if (secret) loadAll();
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
