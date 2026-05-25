import { createDashboardRenderer } from "./dashboard-render.js";
import { fmt, msToSecondsLabel } from "./dashboard-utils.js";

// Register Service Worker for caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Silently fail if service worker registration fails
    });
  });
}

const API_BASE = "";
const SNAPSHOT_API_PATH = "/api/dashboard-snapshot";
const DEFAULT_POLL_MS = 120_000;
const DEFAULT_HEAVY_POLL_MS = 600_000;
const HIDDEN_TAB_MULTIPLIER = 5;
const FOCUS_REFRESH_COOLDOWN_MS = 30_000;
const ALLOWED_POLL_MS = [60_000, 120_000];

const elementCache = new Map();
const $ = (id) => {
  if (elementCache.has(id)) return elementCache.get(id);
  const el = document.getElementById(id);
  if (el) elementCache.set(id, el);
  return el;
};
const esc = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const state = {
  isAuthenticated: false,
  lightPollTimer: null,
  heavyPollTimer: null,
  healthTickTimer: null,
  pollMs: Number(localStorage.getItem("ikiru_poll_ms") || DEFAULT_POLL_MS),
  autoRefreshEnabled: localStorage.getItem("ikiru_auto_refresh") !== "off",
  isProcessing: false,
  loadAbortController: null,
  lightAbortController: null,
  heavyAbortController: null,
  lastHeavyLoadAt: 0,
  lastLightLoadAt: 0,
  lastFocusRefreshAt: 0,
  latestStatusData: null,
  latestWhitelistData: null,
  latestRecentData: null,
  whitelistItems: [],
  whitelistPage: 1,
  whitelistPageSize: 50,
  whitelistSortOrder: "default",
  logsItems: [],
  logTagFilter: "all",
  recentItems: [],
  analyticsData: null,
  dailyStats: [],
  trendChart: null,
  sourceChart: null,
  pendingDeleteResolver: null,
  globalSearchQuery: "",
  nextCronRunAt: null,
  countdownInterval: null,
};
if (!ALLOWED_POLL_MS.includes(state.pollMs)) state.pollMs = DEFAULT_POLL_MS;

const renderer = createDashboardRenderer({ state, $, esc });
const {
  applyWhitelistFilter,
  applyLogFilter,
  setLogTagFilter,
  renderErr,
  renderLastCronResult,
  renderLogs,
  renderRecent,
  renderSourceChart,
  renderSourceHealth,
  renderSummaryPanels,
  renderTrendChart,
  renderWhitelist,
  setSortOrder,
  skeleton,
  skeletonRecent,
} = renderer;

function resolveHeavyPollMs() {
  return Math.max(DEFAULT_HEAVY_POLL_MS, state.pollMs * 4);
}

function currentLightPollMs() {
  return document.hidden ? state.pollMs * HIDDEN_TAB_MULTIPLIER : state.pollMs;
}

function currentHeavyPollMs() {
  const base = resolveHeavyPollMs();
  return document.hidden ? base * HIDDEN_TAB_MULTIPLIER : base;
}

function showAlert(message) {
  const el = $("alertBox");
  if (!el) return;
  el.style.display = "block";
  el.textContent = message;
  setTimeout(() => {
    el.style.display = "none";
  }, 8000);
  showToast(message, "warn");
}

function clearAlert() {
  const el = $("alertBox");
  if (el) el.style.display = "none";
}

function showToast(message, type = "success", timeoutMs = 2600) {
  const wrap = $("toastContainer");
  if (!wrap) return null;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = String(message || "");
  wrap.appendChild(toast);
  if (timeoutMs > 0) {
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, timeoutMs);
  }
  return toast;
}

function openDeleteConfirm(title) {
  const overlay = $("deleteConfirmOverlay");
  const text = $("deleteConfirmText");
  if (!overlay || !text) return Promise.resolve(true);
  text.textContent = `Yakin ingin menghapus "${title}" dari whitelist?`;
  overlay.classList.add("show");
  return new Promise((resolve) => {
    state.pendingDeleteResolver = resolve;
  });
}

function resolveDeleteConfirm(accepted) {
  const overlay = $("deleteConfirmOverlay");
  if (overlay) overlay.classList.remove("show");
  if (state.pendingDeleteResolver)
    state.pendingDeleteResolver(Boolean(accepted));
  state.pendingDeleteResolver = null;
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

async function addManga() {
  const titleInput = $("inputMangaTitle");
  const urlInput = $("inputMangaUrl");
  const btn = $("btnAddManga");
  const title = titleInput?.value.trim() || "";
  const url = urlInput?.value.trim() || "";

  if (!title) {
    titleInput?.focus();
    return;
  }

  state.isProcessing = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "...";
  }
  const loadingToast = showToast("Menambah manga...", "info", 0);

  try {
    const response = await fetch(`${API_BASE}/api/whitelist`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, url: url || null }),
    });
    const data = await response.json();
    loadingToast?.remove();
    if (!response.ok) {
      showAlert(data.error || "Gagal menambah manga");
      return;
    }
    if (titleInput) titleInput.value = "";
    if (urlInput) urlInput.value = "";
    renderWhitelist(data);
    showToast("Manga berhasil ditambahkan", "success");
  } catch (err) {
    showAlert(`Gagal: ${err.message}`);
  } finally {
    state.isProcessing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "+ Tambah";
    }
  }
}

function copyWhitelistUrlByIndex(index) {
  const item = state.whitelistItems?.[index];
  if (!item || typeof item === "string") {
    copyUrl("");
    return;
  }
  const targetUrl =
    Array.isArray(item.sources) && item.sources.length > 0
      ? item.sources.find((s) => s.url)?.url || item.sources[0].url
      : item.url;
  copyUrl(targetUrl || "");
}

async function toggleMarkReadByIndex(index) {
  const item = state.whitelistItems?.[index];
  if (!item) return;

  const title = typeof item === "string" ? item : item.title;
  const isRead = (item.sources || []).some((s) => s.mark === "read");
  const nextMark = isRead ? null : "read";

  state.isProcessing = true;
  try {
    const response = await fetch(`${API_BASE}/api/whitelist`, {
      method: "PATCH",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, mark: nextMark }),
    });
    const data = await response.json();
    if (!response.ok) {
      showAlert(data.error || "Gagal update status");
      return;
    }
    renderWhitelist(data);
    showToast(
      nextMark === "read" ? "Ditandai sudah baca" : "Status baca dihapus",
      "success",
    );
  } catch (err) {
    showAlert(`Gagal: ${err.message}`);
  } finally {
    state.isProcessing = false;
  }
}

async function syncMangaByIndex(index) {
  const item = state.whitelistItems?.[index];
  if (!item) return;

  const title = typeof item === "string" ? item : item.title;
  if (state.isProcessing) return;

  state.isProcessing = true;
  const loadingToast = showToast(`Syncing ${title}...`, "info", 0);
  
  try {
    const response = await fetch(`${API_BASE}/api/admin-actions`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${localStorage.getItem("ikiru_bearer_token")}`
      },
      body: JSON.stringify({ action: "sync-manga", title }),
    });
    
    const data = await response.json();
    loadingToast?.remove();
    
    if (!response.ok) {
      showAlert(data.error || "Gagal sync manga");
      return;
    }
    
    const result = data.data || data;
    if (result.sent > 0) {
      showToast(`Sync berhasil! Mengirim ${result.sent} chapter ke Discord.`, "success");
    } else {
      showToast(result.message || "Tidak ada chapter baru ditemukan.", "info");
    }
    
    await loadAll();
  } catch (err) {
    showAlert(`Gagal: ${err.message}`);
  } finally {
    state.isProcessing = false;
  }
}

async function deleteMangaByIndex(index) {
  const item = state.whitelistItems?.[index];
  if (!item) return;

  const title = typeof item === "string" ? item : item.title;
  const ok = await openDeleteConfirm(title);
  if (!ok) return;

  state.isProcessing = true;
  const loadingToast = showToast("Menghapus manga...", "info", 0);
  try {
    const response = await fetch(`${API_BASE}/api/whitelist`, {
      method: "DELETE",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = await response.json();
    loadingToast?.remove();
    if (!response.ok) {
      showAlert(data.error || "Gagal menghapus");
      return;
    }
    state.whitelistPage = 1;
    renderWhitelist(data);
    showToast("Manga berhasil dihapus", "success");
  } catch (err) {
    showAlert(`Gagal: ${err.message}`);
  } finally {
    state.isProcessing = false;
  }
}

async function deleteMangaByTitle(title) {
  if (!title) return;
  const ok = await openDeleteConfirm(title);
  if (!ok) return;

  state.isProcessing = true;
  const loadingToast = showToast("Menghapus manga...", "info", 0);
  try {
    const response = await fetch(`${API_BASE}/api/whitelist`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = await response.json();
    loadingToast?.remove();
    if (!response.ok) {
      showAlert(data.error || "Gagal menghapus");
      return;
    }
    state.whitelistPage = 1;
    renderWhitelist(data);
    showToast("Manga berhasil dihapus", "success");
  } catch (err) {
    showAlert(`Gagal: ${err.message}`);
  } finally {
    state.isProcessing = false;
  }
}

function setWhitelistPage(page) {
  state.whitelistPage = page;
  applyWhitelistFilter();
}
window.setWhitelistPage = setWhitelistPage;

function changeWhitelistPage(delta) {
  const filtered = state.whitelistItems;
  const totalPages = Math.ceil(filtered.length / state.whitelistPageSize) || 1;
  const newPage = state.whitelistPage + delta;
  if (newPage >= 1 && newPage <= totalPages) {
    state.whitelistPage = newPage;
    applyWhitelistFilter();
  }
}
window.changeWhitelistPage = changeWhitelistPage;

function checkAuth() {
  if (!state.isAuthenticated) {
    $("modalOverlay")?.classList.add("show");
    return false;
  }
  return true;
}

async function runCronNow() {
  if (!checkAuth() || state.isProcessing) return;
  const btn = $("btnRunCron");
  const oldText = btn?.textContent || "jalankan cron";
  state.isProcessing = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'loading<span class="loading-dots"></span>';
  }

  const loadingToast = showToast("Menjalankan cron job...", "info", 0);
  try {
    const response = await fetch(`${API_BASE}/api/cron`, {
      method: "POST",
      cache: "no-store",
    });
    const responseData = await response.json();
    loadingToast?.remove();
    if (!response.ok) {
      showAlert(responseData.error?.message || "Cron gagal dijalankan");
      return;
    }
    const resultData = responseData.data || responseData;
    showAlert(
      `Cron selesai: sent ${resultData.sent ?? 0}, skipped ${resultData.skipped ?? 0}, failed ${resultData.failed ?? 0}`,
    );
    renderLastCronResult(
      {
        sent: resultData.sent,
        skipped: resultData.skipped,
        failed: resultData.failed,
        duration: resultData.duration,
        timestamp: new Date().toISOString(),
      },
      true,
    );
    await loadAll();
  } catch {
    showAlert("Gagal trigger cron. Periksa koneksi atau console.");
  } finally {
    state.isProcessing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

async function adminAction(action) {
  if (!checkAuth() || state.isProcessing) return;
  
  const confirmMsg = action === "clear-cache" 
    ? "Yakin ingin menghapus cache whitelist?" 
    : action === "force-unlock"
      ? "Yakin ingin memaksa hapus semua lock distributed Redis?"
      : action === "reset-health"
        ? "Yakin ingin meriset semua status circuit breaker kesehatan sumber?"
        : "Yakin ingin memaksa sinkronisasi database?";
    
  if (!confirm(confirmMsg)) return;

  state.isProcessing = true;
  const loadingToast = showToast("Memproses aksi admin...", "info", 0);

  try {
    const response = await fetch(`${API_BASE}/api/admin-actions`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    
    const data = await response.json();
    loadingToast?.remove();
    if (!response.ok) {
      showAlert(data.error || "Aksi admin gagal");
      return;
    }
    
    showToast(data.message || "Aksi berhasil", "success");
    await loadAll();
  } catch (err) {
    showAlert(`Gagal: ${err.message}`);
  } finally {
    state.isProcessing = false;
  }
}
window.adminAction = adminAction;

async function loginDashboard(password) {
  try {
    const response = await fetch(`${API_BASE}/api/auth?action=login`, {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, message: data.error?.message || data.error || "Login gagal" };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: `Login gagal: ${err.message}` };
  }
}

async function submitPassword() {
  const input = $("passwordInput");
  const password = input?.value.trim() || localStorage.getItem("ikiru_dashboard_password") || "";
  if (!password) return;

  const loginResult = await loginDashboard(password);
  if (!loginResult.ok) {
    localStorage.removeItem("ikiru_dashboard_password");
    showAlert(loginResult.message || "Login gagal");
    return;
  }

  // Save for future reloads
  localStorage.setItem("ikiru_dashboard_password", password);

  state.isAuthenticated = true;
  if (input) input.value = "";
  $("modalOverlay")?.classList.remove("show");
  await loadAll();
  startPoll();
}


async function logoutDashboard() {
  if (state.lightAbortController) state.lightAbortController.abort();
  if (state.heavyAbortController) state.heavyAbortController.abort();
  if (state.loadAbortController) state.loadAbortController.abort();
  try {
    await fetch(`${API_BASE}/api/auth?action=logout`, {
      method: "POST",
      cache: "no-store",
    });
  } catch {
    // noop
  }
  state.isAuthenticated = false;
  localStorage.removeItem("ikiru_bearer_token");
  localStorage.removeItem("ikiru_dashboard_password");
  $("modalOverlay")?.classList.add("show");
  clearInterval(state.lightPollTimer);
  clearInterval(state.heavyPollTimer);
  clearInterval(state.healthTickTimer);
  state.lightAbortController = null;
  state.heavyAbortController = null;
  state.loadAbortController = null;
}

async function bootstrapAuth() {
  const loadingScreen = $("loadingScreen");
  const timeout = setTimeout(() => {
    if (loadingScreen && loadingScreen.style.display !== "none") {
      const text = loadingScreen.querySelector("p");
      if (text) text.textContent = "Still loading... checking auth";
    }
  }, 3000);

  try {
    const controller = new AbortController();
    const authTimeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${API_BASE}/api/auth?action=status`, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    });
    clearTimeout(authTimeout);
    const data = await response.json();
    state.isAuthenticated = Boolean(data?.authenticated);
  } catch {
    state.isAuthenticated = false;
  }

  clearTimeout(timeout);
  if (loadingScreen) {
    loadingScreen.style.opacity = "0";
    setTimeout(() => { loadingScreen.style.display = "none"; }, 300);
  }

  if (state.isAuthenticated) {
    $("modalOverlay")?.classList.remove("show");
    loadAll();
    startPoll();
  } else {
    // Try auto-login if password exists in localStorage
    const storedPassword = localStorage.getItem("ikiru_dashboard_password");
    if (storedPassword) {
        submitPassword();
    } else {
        $("modalOverlay")?.classList.add("show");
    }
  }
}

async function apiFetch(path, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.any([signal, controller.signal]),
    });
    clearTimeout(timeoutId);
    if (response.status === 401) {
      state.isAuthenticated = false;
      $("modalOverlay")?.classList.add("show");
      throw new Error("Unauthorized");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload?.data ?? payload;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function loadLightData() {
  if (!checkAuth()) return;

  if (state.lightAbortController) state.lightAbortController.abort();
  const controller = new AbortController();
  state.lightAbortController = controller;
  
  const loadTimeout = setTimeout(() => {
    controller.abort();
    showAlert("Request timeout - server tidak menjawab");
  }, 20000);

  try {
    const snapshot = await apiFetch(SNAPSHOT_API_PATH, controller.signal);
    clearTimeout(loadTimeout);

    if (state.lightAbortController !== controller) return;
    if (!state.isAuthenticated) return;

    if (snapshot.success === false) {
      throw new Error(snapshot.error?.message || snapshot.error || "Gagal memuat data");
    }

    const rawCronStatus = snapshot.cronStatus || {};
    state.latestStatusData = rawCronStatus.body || rawCronStatus;
    state.latestStatusData.sourceHealth = snapshot.sourceHealth;
    state.latestStatusData.recommendations = snapshot.recommendations;
    state.latestStatusData.queueLength = snapshot.queueLength;
    state.latestStatusData.queueItems = snapshot.queueItems || [];
    state.latestStatusData.liveEvents = snapshot.liveEvents;
    state.latestStatusData.fastCron = snapshot.fastCron;
    state.latestStatusData.networks = snapshot.networks;
    state.latestStatusData.providerMetrics = snapshot.providerMetrics;

    if (snapshot.fastCron?.nextRun?.timestamp) {
      state.nextCronRunAt = snapshot.fastCron.nextRun.timestamp * 1000;
      startCountdown();
    }

    if (snapshot.whitelist) {
      state.latestWhitelistData = snapshot.whitelist;
      renderWhitelist(state.latestWhitelistData);
    }

    state.latestRecentData = { items: snapshot.recentChapters || [] };
    state.recentItems = snapshot.recentChapters || [];

    if (snapshot.analytics) {
      state.analyticsData = snapshot.analytics;
    }

    if (snapshot.dailyStats?.length) {
      state.dailyStats = snapshot.dailyStats;
    }

    if (snapshot.recentLogs) {
      state.logsItems = snapshot.recentLogs;
    }

    renderSummaryPanels();
    renderRecent({ items: snapshot.recentChapters });
    if (snapshot.recentLogs) renderLogs({ logs: snapshot.recentLogs });

    renderTrendChart();
    renderSourceChart();
    updateFooterStatus(snapshot);

    const loadingScreen = $("loadingScreen");
    if (loadingScreen && loadingScreen.style.display !== "none") {
      loadingScreen.style.opacity = "0";
      setTimeout(() => loadingScreen.style.display = "none", 300);
    }

    const lastUpdated = $("lastUpdated");
    if (lastUpdated) lastUpdated.textContent = `diperbarui ${fmt(new Date())}`;
    state.lastLightLoadAt = Date.now();
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("Light load failed:", err);
      showErrorState(err.message);
    }
  } finally {
    if (state.lightAbortController === controller)
      state.lightAbortController = null;
  }
}

function showErrorState(message = "Failed to load data") {
  const loadingScreen = $("loadingScreen");
  if (loadingScreen) loadingScreen.style.display = "none";

  const sections = ["mangaList", "recentList", "logList", "sourceHealthList"];
  sections.forEach(id => {
    const el = $(id);
    if (el) {
      el.innerHTML = `
        <li class="empty error-state">
          <span class="error-icon">⚠️</span>
          <p>${esc(message)}</p>
          <button class="btn-soft" onclick="loadAll()">Retry</button>
        </li>
      `;
    }
  });

  showToast(`Error: ${message}`, "error");
  const statusDot = $("footerStatusDot");
  const statusText = $("footerStatusText");
  if (statusDot) {
    statusDot.className = "status-indicator-dot error";
    statusDot.style.animation = "none";
  }
  if (statusText) statusText.textContent = "Connection error";
}

async function loadHeavyData() {
  if (!checkAuth()) return;
  return Promise.resolve();
}

async function loadAll() {
  if (!checkAuth()) return;
  clearAlert();

  if (state.lightAbortController) state.lightAbortController.abort();
  if (state.heavyAbortController) state.heavyAbortController.abort();
  if (state.loadAbortController) state.loadAbortController.abort();
  const controller = new AbortController();
  state.loadAbortController = controller;

  const btn = $("btnRefresh");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 0.8s linear infinite"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
  }

  skeleton($("mangaList"), 5);
  skeletonRecent($("recentList"), 4);
  skeleton($("logList"), 6);
  skeleton($("sourceHealthList"), 3);

  state.isProcessing = true;
  try {
    await loadLightData();
    showToast("Dashboard diperbarui", "success");
  } catch (err) {
    if (err.name !== "AbortError") {
      showAlert(`Refresh gagal: ${err.message}`);
    }
  } finally {
    state.isProcessing = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
    }
    if (state.loadAbortController === controller)
      state.loadAbortController = null;
  }
}

function startPoll() {
  clearInterval(state.lightPollTimer);
  clearInterval(state.heavyPollTimer);
  clearInterval(state.healthTickTimer);

  if (!state.autoRefreshEnabled) return;

  state.lightPollTimer = setInterval(() => {
    if (!state.isProcessing) loadLightData();
  }, currentLightPollMs());

  state.heavyPollTimer = setInterval(() => {
    if (!state.isProcessing) loadHeavyData();
  }, currentHeavyPollMs());

  startHealthTicker();
}

function startHealthTicker() {
  clearInterval(state.healthTickTimer);
  state.healthTickTimer = setInterval(() => {
    if (state.isProcessing || !state.latestStatusData) return;
    const healthMap = state.latestStatusData.sourceHealth || {};
    const hasCooldown = Object.values(healthMap).some((h) => {
      const target = h?.disabledUntil ? new Date(h.disabledUntil).getTime() : 0;
      return target > Date.now();
    });
    if (hasCooldown) renderSourceHealth(state.latestStatusData);
  }, 1000);
}

function updateAutoRefreshUI() {
  const btn = $("btnAutoRefresh");
  const select = $("pollInterval");
  if (select) select.value = String(state.pollMs);
  if (btn) btn.textContent = state.autoRefreshEnabled ? "auto: on" : "auto: off";
}

function toggleAutoRefresh() {
  state.autoRefreshEnabled = !state.autoRefreshEnabled;
  localStorage.setItem("ikiru_auto_refresh", state.autoRefreshEnabled ? "on" : "off");
  updateAutoRefreshUI();
  startPoll();
  showToast(state.autoRefreshEnabled ? "Realtime updates enabled" : "Realtime updates disabled", state.autoRefreshEnabled ? "success" : "warn");
}

function setPollInterval() {
  const select = $("pollInterval");
  if (!select) return;
  const next = Number(select.value);
  if (!ALLOWED_POLL_MS.includes(next)) return;
  state.pollMs = next;
  localStorage.setItem("ikiru_poll_ms", String(state.pollMs));
  updateAutoRefreshUI();
  startPoll();
}

function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  const themeButton = $("btnTheme");
  if (themeButton) themeButton.textContent = dark ? "☀️" : "🌙";
  renderTrendChart();
  renderSourceChart();
}

function toggleTheme() {
  const isDark = !document.body.classList.contains("dark");
  localStorage.setItem("ikiru_theme", isDark ? "dark" : "light");
  applyTheme(isDark);
}

$("passwordInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitPassword();
});
$("deleteCancelBtn")?.addEventListener("click", () => resolveDeleteConfirm(false));
$("deleteConfirmBtn")?.addEventListener("click", () => resolveDeleteConfirm(true));
$("deleteConfirmOverlay")?.addEventListener("click", (event) => {
  if (event.target === $("deleteConfirmOverlay")) resolveDeleteConfirm(false);
});

window.addEventListener("focus", () => {
  if (!state.isAuthenticated || state.isProcessing) return;
  const now = Date.now();
  if (now - state.lastFocusRefreshAt < FOCUS_REFRESH_COOLDOWN_MS) return;
  state.lastFocusRefreshAt = now;
  if (now - state.lastLightLoadAt > Math.min(currentLightPollMs(), FOCUS_REFRESH_COOLDOWN_MS)) loadLightData();
  if (now - state.lastHeavyLoadAt > currentHeavyPollMs()) loadHeavyData();
});

document.addEventListener("visibilitychange", () => {
  updateAutoRefreshUI();
  startPoll();
  if (document.hidden) stopCountdown();
  else if (state.nextCronRunAt) startCountdown();
});

function startCountdown() {
  stopCountdown();
  if (!state.nextCronRunAt) return;
  updateCountdown();
  state.countdownInterval = setInterval(updateCountdown, 1000);
}

function stopCountdown() {
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
}

function updateCountdown() {
  if (!state.nextCronRunAt) return;
  const now = Date.now();
  const diff = state.nextCronRunAt - now;
  const countdownEl = $("cronCountdown");
  if (!countdownEl) return;
  if (diff <= 0) {
    countdownEl.innerHTML = 'Running<span class="loading-dots"></span>';
    countdownEl.style.color = "var(--green)";
    return;
  }
  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const timeStr = hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  countdownEl.textContent = timeStr;
  countdownEl.setAttribute("data-text", timeStr);
  
  const t6 = $("t6");
  if (t6) {
    t6.textContent = timeStr;
    t6.setAttribute("data-text", timeStr);
  }

  if (minutes < 1) countdownEl.style.color = "var(--red)";
  else if (minutes < 5) countdownEl.style.color = "var(--amber)";
  else countdownEl.style.color = "var(--accent)";
}

function updateFooterStatus(snapshot) {
  const statusDot = $("footerStatusDot");
  const statusText = $("footerStatusText");
  const topDot = $("statusDot");
  const topText = $("topStatusText");
  const topTime = $("topLastUpdated");
  const footerTime = $("footerLastUpdated");

  const nowStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
  if (topTime) topTime.textContent = nowStr;
  if (footerTime) footerTime.textContent = nowStr;

  // Ticker updates
  const t2 = $("t2"), t2b = $("t2b");
  if (t2) t2.textContent = snapshot.lastCronRunAt ? new Date(snapshot.lastCronRunAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : "--:--";
  if (t2b) t2b.textContent = t2.textContent;
  
  const t3 = $("t3"), t3b = $("t3b");
  if (t3) t3.textContent = snapshot.overview?.sent24h || "--";
  if (t3b) t3b.textContent = t3.textContent;
  
  const t4 = $("t4");
  if (t4) t4.textContent = snapshot.overview?.whitelist || "--";
  
  const t5 = $("t5");
  if (t5) t5.textContent = snapshot.cronStatus?.successRate ? snapshot.cronStatus.successRate + "%" : "--%";

  if (!statusDot || !statusText) return;
  const hasErrors = snapshot.cronStatus?.failed > 0;
  const hasSourceErrors = Object.values(snapshot.sourceHealth || {}).some((h) => h?.consecutiveFailures > 0);
  const isQueueBackedUp = (snapshot.queueLength || 0) > 50;
  
  let statusClass = "status-indicator-dot";
  let statusMsg = "All systems operational";
  let tickerStatus = "NOMINAL";
  
  if (hasErrors || hasSourceErrors) {
    statusClass = "status-indicator-dot error";
    statusMsg = "System degraded - Error detected";
    tickerStatus = "DEGRADED";
  } else if (isQueueBackedUp) {
    statusClass = "status-indicator-dot warning";
    statusMsg = "System under load - Queue backlog";
    tickerStatus = "WARNING";
  }
  
  statusDot.className = statusClass;
  statusText.textContent = statusMsg;
  if (topDot) topDot.className = hasErrors || hasSourceErrors ? "status-dot error" : "status-dot";
  if (topText) topText.textContent = statusMsg;
  
  const t1 = $("t1");
  if (t1) {
    t1.textContent = tickerStatus;
    t1.style.color = tickerStatus === "NOMINAL" ? "var(--green)" : "var(--red)";
  }
}

applyTheme(localStorage.getItem("ikiru_theme") === "dark");
updateAutoRefreshUI();
bootstrapAuth();

Object.assign(window, {
  addManga,
  applyWhitelistFilter,
  applyLogFilter,
  setLogTagFilter,
  changeWhitelistPage,
  setWhitelistPage,
  copyUrl,
  copyWhitelistUrlByIndex,
  deleteMangaByIndex,
  deleteMangaByTitle,
  loadAll,
  logoutDashboard,
  renderTrendChart,
  runCronNow,
  setPollInterval,
  setSortOrder,
  submitPassword,
  toggleAutoRefresh,
  toggleTheme,
  toggleMarkReadByIndex,
  syncMangaByIndex,
});
