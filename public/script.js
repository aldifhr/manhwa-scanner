import { createDashboardRenderer } from "./dashboard-render.js";
import { fmt, msToSecondsLabel } from "./dashboard-utils.js";

const API_BASE = "";
const STATUS_API_PATH = "/api/status?realtime=1";
const DASHBOARD_PASSWORD_STORAGE_KEY = "ikiru_dashboard_password";
const DEFAULT_POLL_MS = 120_000;
const DEFAULT_HEAVY_POLL_MS = 600_000;
const HIDDEN_TAB_MULTIPLIER = 5;
const FOCUS_REFRESH_COOLDOWN_MS = 30_000;
const ALLOWED_POLL_MS = [60_000, 120_000];

const elementCache = new Map();
const $ = (id) => {
  if (!elementCache.has(id)) elementCache.set(id, document.getElementById(id));
  return elementCache.get(id);
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
  whitelistSortOrder: "default",
  logsItems: [],
  recentItems: [],
  trendChart: null,
  sourceChart: null,
  pendingDeleteResolver: null,
};
if (!ALLOWED_POLL_MS.includes(state.pollMs)) state.pollMs = DEFAULT_POLL_MS;

const renderer = createDashboardRenderer({ state, $, esc });
const {
  applyWhitelistFilter,
  renderErr,
  renderLastCronResult,
  renderLogs,
  renderRecent,
  renderSourceChart,
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

  try {
    const response = await fetch(`${API_BASE}/api/whitelist`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, url: url || null }),
    });
    const data = await response.json();
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

async function deleteMangaByIndex(index) {
  const item = state.whitelistItems?.[index];
  if (!item) return;

  const title = typeof item === "string" ? item : item.title;
  const ok = await openDeleteConfirm(title);
  if (!ok) return;

  state.isProcessing = true;
  try {
    const response = await fetch(`${API_BASE}/api/whitelist`, {
      method: "DELETE",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = await response.json();
    if (!response.ok) {
      showAlert(data.error || "Gagal menghapus");
      return;
    }
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
  try {
    const response = await fetch(`${API_BASE}/api/whitelist`, {
      method: "DELETE",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = await response.json();
    if (!response.ok) {
      showAlert(data.error || "Gagal menghapus");
      return;
    }
    renderWhitelist(data);
    showToast("Manga berhasil dihapus", "success");
    // Also refresh status to update recommendations
    await loadLightData();
  } catch (err) {
    showAlert(`Gagal: ${err.message}`);
  } finally {
    state.isProcessing = false;
  }
}

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
    btn.textContent = "running...";
  }

  try {
    const response = await fetch(`${API_BASE}/api/cron`, {
      method: "POST",
      cache: "no-store",
    });
    const responseData = await response.json();
    if (!response.ok) {
      showAlert(responseData.error?.message || "Cron gagal dijalankan");
      return;
    }
    // Handle both new format (responseData.data) and old format (direct properties)
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

async function submitPassword() {
  const input = $("passwordInput");
  const password = input?.value.trim() || "";
  if (!password) return;

  const loginResult = await loginDashboard(password);
  if (!loginResult.ok) {
    showAlert(loginResult.message || "Login gagal");
    return;
  }

  localStorage.setItem(DASHBOARD_PASSWORD_STORAGE_KEY, password);
  state.isAuthenticated = true;
  if (input) input.value = "";
  $("modalOverlay")?.classList.remove("show");
  await loadAll();
  startPoll();
}

async function loginDashboard(password) {
  try {
    const response = await fetch(`${API_BASE}/api/auth?action=login`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, message: data.error || "Login gagal" };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: `Login gagal: ${err.message}` };
  }
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
  $("modalOverlay")?.classList.add("show");
  clearInterval(state.lightPollTimer);
  clearInterval(state.heavyPollTimer);
  state.lightAbortController = null;
  state.heavyAbortController = null;
  state.loadAbortController = null;
}

async function bootstrapAuth() {
  try {
    const response = await fetch(`${API_BASE}/api/auth?action=status`, {
      method: "GET",
      cache: "no-store",
    });
    const data = await response.json();
    state.isAuthenticated = Boolean(data?.authenticated);
  } catch {
    state.isAuthenticated = false;
  }

  if (state.isAuthenticated) {
    $("modalOverlay")?.classList.remove("show");
    loadAll();
    startPoll();
  } else {
    const savedPassword =
      localStorage.getItem(DASHBOARD_PASSWORD_STORAGE_KEY) || "";
    if (savedPassword) {
      const loginResult = await loginDashboard(savedPassword);
      if (loginResult.ok) {
        state.isAuthenticated = true;
        $("modalOverlay")?.classList.remove("show");
        const input = $("passwordInput");
        if (input) input.value = savedPassword;
        loadAll();
        startPoll();
        return;
      }
      localStorage.removeItem(DASHBOARD_PASSWORD_STORAGE_KEY);
    }
    $("modalOverlay")?.classList.add("show");
    const input = $("passwordInput");
    if (input) {
      input.value = localStorage.getItem(DASHBOARD_PASSWORD_STORAGE_KEY) || "";
    }
  }
}

async function apiFetch(path, signal) {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    signal,
  });
  if (response.status === 401) {
    state.isAuthenticated = false;
    $("modalOverlay")?.classList.add("show");
    throw new Error("Unauthorized");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadLightData() {
  if (!checkAuth()) return;

  if (state.lightAbortController) state.lightAbortController.abort();
  const controller = new AbortController();
  state.lightAbortController = controller;

  try {
    const [statusResult, recentResult] = await Promise.allSettled([
      apiFetch(STATUS_API_PATH, controller.signal),
      apiFetch("/api/history?action=recent", controller.signal),
    ]);

    if (state.lightAbortController !== controller) return;
    if (!state.isAuthenticated) return;

    if (statusResult.status === "fulfilled") {
      state.latestStatusData = statusResult.value;
      renderSummaryPanels();
    } else if (
      statusResult.reason?.name !== "AbortError" &&
      !state.latestStatusData
    ) {
      renderSummaryPanels();
    }

    if (recentResult.status === "fulfilled") {
      state.latestRecentData = recentResult.value;
      renderRecent(state.latestRecentData);
      renderSummaryPanels();
    } else if (
      recentResult.reason?.name !== "AbortError" &&
      !state.latestRecentData
    ) {
      renderErr($("recentList"), "Gagal muat recent data");
    }

    const lastUpdated = $("lastUpdated");
    if (lastUpdated) lastUpdated.textContent = `diperbarui ${fmt(new Date())}`;
    state.lastLightLoadAt = Date.now();
  } finally {
    if (state.lightAbortController === controller)
      state.lightAbortController = null;
  }
}

async function loadHeavyData() {
  if (!checkAuth()) return;

  if (state.heavyAbortController) state.heavyAbortController.abort();
  const controller = new AbortController();
  state.heavyAbortController = controller;

  try {
    const [whitelistResult, logsResult] = await Promise.allSettled([
      apiFetch("/api/whitelist", controller.signal),
      apiFetch("/api/history?action=logs", controller.signal),
    ]);

    if (state.heavyAbortController !== controller) return;
    if (!state.isAuthenticated) return;

    if (whitelistResult.status === "fulfilled") {
      state.latestWhitelistData = whitelistResult.value;
      renderWhitelist(state.latestWhitelistData);
      renderSummaryPanels();
    } else if (
      whitelistResult.reason?.name !== "AbortError" &&
      !state.latestWhitelistData
    ) {
      renderErr($("mangaList"), "Gagal muat whitelist");
    }

    if (logsResult.status === "fulfilled") {
      renderLogs(logsResult.value);
    } else if (logsResult.reason?.name !== "AbortError") {
      renderErr($("logList"), "Gagal muat logs");
    }

    const lastUpdated = $("lastUpdated");
    if (lastUpdated) lastUpdated.textContent = `diperbarui ${fmt(new Date())}`;
    state.lastHeavyLoadAt = Date.now();
  } finally {
    if (state.heavyAbortController === controller)
      state.heavyAbortController = null;
  }
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
    btn.textContent = "memuat...";
  }

  skeleton($("mangaList"), 5);
  skeletonRecent($("recentList"), 4);
  skeleton($("logList"), 6);
  skeleton($("sourceHealthList"), 3);

  try {
    const [statusResult, whitelistResult, recentResult, logsResult] =
      await Promise.allSettled([
        apiFetch(STATUS_API_PATH, controller.signal),
        apiFetch("/api/whitelist", controller.signal),
        apiFetch("/api/history?action=recent", controller.signal),
        apiFetch("/api/history?action=logs", controller.signal),
      ]);

    if (state.loadAbortController !== controller) return;
    if (!state.isAuthenticated) return;

    const statusData =
      statusResult.status === "fulfilled" ? statusResult.value : null;
    const whitelistData =
      whitelistResult.status === "fulfilled" ? whitelistResult.value : null;
    const recentData =
      recentResult.status === "fulfilled" ? recentResult.value : null;
    const logsData =
      logsResult.status === "fulfilled" ? logsResult.value : null;

    state.latestStatusData = statusData;
    state.latestWhitelistData = whitelistData;
    state.latestRecentData = recentData;
    renderSummaryPanels();

    if (whitelistData) renderWhitelist(whitelistData);
    else renderErr($("mangaList"), "Gagal muat whitelist");

    if (recentData) renderRecent(recentData);
    else renderErr($("recentList"), "Gagal muat recent data");

    if (logsData) renderLogs(logsData);
    else renderErr($("logList"), "Gagal muat logs");

    const anyFailed = [
      statusResult,
      whitelistResult,
      recentResult,
      logsResult,
    ].some(
      (result) =>
        result.status === "rejected" && result.reason?.name !== "AbortError",
    );
    if (anyFailed && state.isAuthenticated) {
      showAlert("Beberapa endpoint gagal dimuat. Coba refresh lagi.");
    }

    const lastUpdated = $("lastUpdated");
    if (lastUpdated) lastUpdated.textContent = `diperbarui ${fmt(new Date())}`;
    state.lastHeavyLoadAt = Date.now();
    renderTrendChart();
    renderSourceChart();
  } finally {
    if (state.loadAbortController === controller)
      state.loadAbortController = null;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "refresh";
    }
  }
}

function startPoll() {
  clearInterval(state.lightPollTimer);
  clearInterval(state.heavyPollTimer);
  if (!state.autoRefreshEnabled) return;
  state.lightPollTimer = setInterval(() => {
    if (!state.isProcessing) loadLightData();
  }, currentLightPollMs());
  state.heavyPollTimer = setInterval(() => {
    if (!state.isProcessing) loadHeavyData();
  }, currentHeavyPollMs());
}

function updateAutoRefreshUI() {
  const btn = $("btnAutoRefresh");
  const select = $("pollInterval");
  const pollInfo = $("pollInfo");
  if (select) select.value = String(state.pollMs);
  if (btn)
    btn.textContent = state.autoRefreshEnabled ? "auto: on" : "auto: off";
  if (!pollInfo) return;
  if (!state.autoRefreshEnabled) {
    pollInfo.textContent = "light: off | heavy: off";
    return;
  }
  const hiddenSuffix = document.hidden ? " | bg: hemat" : "";
  pollInfo.textContent = `light: ${msToSecondsLabel(currentLightPollMs())} | heavy: ${msToSecondsLabel(currentHeavyPollMs())}${hiddenSuffix}`;
}

function toggleAutoRefresh() {
  state.autoRefreshEnabled = !state.autoRefreshEnabled;
  localStorage.setItem(
    "ikiru_auto_refresh",
    state.autoRefreshEnabled ? "on" : "off",
  );
  updateAutoRefreshUI();
  startPoll();
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
  if (themeButton) themeButton.textContent = dark ? "dark" : "light";
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
$("deleteCancelBtn")?.addEventListener("click", () =>
  resolveDeleteConfirm(false),
);
$("deleteConfirmBtn")?.addEventListener("click", () =>
  resolveDeleteConfirm(true),
);
$("deleteConfirmOverlay")?.addEventListener("click", (event) => {
  if (event.target === $("deleteConfirmOverlay")) resolveDeleteConfirm(false);
});

window.addEventListener("focus", () => {
  if (!state.isAuthenticated || state.isProcessing) return;
  const now = Date.now();
  if (now - state.lastFocusRefreshAt < FOCUS_REFRESH_COOLDOWN_MS) return;
  state.lastFocusRefreshAt = now;

  if (
    now - state.lastLightLoadAt >
    Math.min(currentLightPollMs(), FOCUS_REFRESH_COOLDOWN_MS)
  ) {
    loadLightData();
  }
  if (now - state.lastHeavyLoadAt > currentHeavyPollMs()) {
    loadHeavyData();
  }
});

document.addEventListener("visibilitychange", () => {
  updateAutoRefreshUI();
  startPoll();
});

applyTheme(localStorage.getItem("ikiru_theme") === "dark");
updateAutoRefreshUI();
bootstrapAuth();

Object.assign(window, {
  addManga,
  applyWhitelistFilter,
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
});
