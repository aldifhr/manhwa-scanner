import {
  bucketKeyForDate,
  countSentLast24h,
  cooldownText,
  fmt,
  getCssVar,
  logFailedCount,
  logSentCount,
  parseDateSafe,
  sourceBadgeClass,
  sourceDisplayName,
  sourceName,
  timeAgo,
  timelineLabel,
} from "./dashboard-utils.js";

export function createDashboardRenderer({ state, $, esc }) {
  function classifySourceHealth(health) {
    if (!health || typeof health !== "object") {
      return {
        tone: "unknown",
        label: "unknown",
        failures: 0,
        extra: "no data",
        errorText: null,
      };
    }

    const degraded = health.status === "degraded";
    const failures = Number(health.consecutiveFailures ?? 0);
    return {
      tone: degraded ? "degraded" : "healthy",
      label: degraded ? "degraded" : "healthy",
      failures,
      extra: degraded
        ? cooldownText(health.disabledUntil) || "cooldown"
        : `ok${health.lastSuccessAt ? ` (${timeAgo(health.lastSuccessAt)})` : ""}`,
      errorText: health.lastError || null,
    };
  }

  function renderTrendChart() {
    const canvas = $("chartTrend");
    if (!canvas || !window.Chart) return;

    const range = $("chartRange")?.value || "24h";
    const now = new Date();
    const buckets = [];
    const sent = [];
    const skipped = [];
    const failed = [];

    if (range === "7d") {
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        buckets.push({
          key: bucketKeyForDate(d),
          label: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
        });
        sent.push(0);
        skipped.push(0);
        failed.push(0);
      }

      for (const log of state.logsItems) {
        const d = parseDateSafe(log?.time);
        if (!d) continue;
        const idx = buckets.findIndex((bucket) => bucket.key === bucketKeyForDate(d));
        if (idx === -1) continue;
        sent[idx] += logSentCount(log);
        if (log.tag === "skipped") skipped[idx] += 1;
        failed[idx] += logFailedCount(log);
      }
    } else {
      for (let i = 23; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setHours(now.getHours() - i, 0, 0, 0);
        buckets.push({
          key: `${bucketKeyForDate(d)}-${d.getHours()}`,
          label: `${String(d.getHours()).padStart(2, "0")}:00`,
        });
        sent.push(0);
        skipped.push(0);
        failed.push(0);
      }

      for (const log of state.logsItems) {
        const d = parseDateSafe(log?.time);
        if (!d) continue;
        const key = `${bucketKeyForDate(d)}-${d.getHours()}`;
        const idx = buckets.findIndex((bucket) => bucket.key === key);
        if (idx === -1) continue;
        sent[idx] += logSentCount(log);
        if (log.tag === "skipped") skipped[idx] += 1;
        failed[idx] += logFailedCount(log);
      }
    }

    if (state.trendChart) state.trendChart.destroy();
    state.trendChart = new window.Chart(canvas, {
      type: "line",
      data: {
        labels: buckets.map((bucket) => bucket.label),
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

    const sourceCounts = {};
    for (const item of state.recentItems) {
      const source = String(item?.source || "ikiru").toLowerCase();
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }

    const labels = Object.keys(sourceCounts).map(s => sourceDisplayName(s));
    const data = Object.values(sourceCounts);
    const backgroundColors = Object.keys(sourceCounts).map(s => {
      if (s === "shinigami_project") return getCssVar("--amber", "#b06b17");
      if (s === "shinigami_mirror") return getCssVar("--accent-2", "#1b9aaa");
      return getCssVar("--green", "#1b8f5a");
    });

    if (state.sourceChart) state.sourceChart.destroy();
    state.sourceChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "updates",
            data,
            backgroundColor: backgroundColors,
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

    const sourceHealthEntries = Object.values(statusData.sourceHealth || {});
    const hasUnknownSource = sourceHealthEntries.some((entry) => !entry || typeof entry !== "object");
    const degraded = Number(statusData.failed ?? 0) > 0 ||
      sourceHealthEntries.some((entry) => entry?.status === "degraded");
    healthEl.textContent = degraded ? "DEGRADED" : hasUnknownSource ? "UNKNOWN" : "HEALTHY";
    healthEl.className = `stat-value ${degraded ? "amber" : hasUnknownSource ? "amber" : "green"}`;

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
      $("lastCronOutcome").textContent = "state: -";
      $("lastCronTime").textContent = "-";
      bar.className = "hero-card";
      return;
    }

    const stateText = statusData.shortCircuitReason
      ? statusData.shortCircuitReason.replace(/_/g, " ")
      : statusData.outcome || "ok";
    $("lastCronSent").textContent = `sent: ${statusData.sent ?? 0}`;
    $("lastCronSkipped").textContent = `skipped: ${statusData.skipped ?? 0}`;
    $("lastCronFailed").textContent = `failed: ${statusData.failed ?? 0}`;
    $("lastCronDuration").textContent = `duration: ${statusData.duration ? `${statusData.duration}s` : "-"}`;
    $("lastCronOutcome").textContent = `state: ${stateText}`;
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
      .map(([source, health], index) => {
        const status = classifySourceHealth(health);
        return `<li class="manga-item">
          <span class="manga-index">${String(index + 1).padStart(2, "0")}</span>
          <span class="manga-item-title">${esc(sourceDisplayName(source))}<br /><small style="opacity:.7">fail streak: ${status.failures}${status.errorText ? ` | ${esc(status.errorText)}` : ""}</small></span>
          <span class="status-pill ${status.tone === "degraded" ? "invalid" : status.tone === "unknown" ? "" : "active"}">${status.label}</span>
          <span class="badge">${esc(status.extra || "-")}</span>
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

  function applyWhitelistFilter() {
    const query = ($("inputWhitelistSearch")?.value ?? "").trim().toLowerCase();
    const sourceFilter = ($("inputWhitelistSource")?.value ?? "").trim().toLowerCase();
    const list = $("mangaList");

    const entries = state.whitelistItems.map((item, originalIndex) => {
      const title = typeof item === "string" ? item : item.title;
      let sources = [];
      if (typeof item === "object" && Array.isArray(item.sources) && item.sources.length > 0) {
        sources = item.sources;
      } else if (typeof item === "object") {
        sources = [{ url: item.url, source: item.source || "ikiru", mark: item.mark }];
      } else {
        sources = [{ url: null, source: "ikiru" }];
      }
      return {
        item,
        title,
        sources,
        titleLower: String(title).toLowerCase(),
        originalIndex,
      };
    });

    if (state.whitelistSortOrder === "az") {
      entries.sort((a, b) => a.titleLower.localeCompare(b.titleLower));
    }
    if (state.whitelistSortOrder === "za") {
      entries.sort((a, b) => b.titleLower.localeCompare(a.titleLower));
    }

    const filtered = entries.filter((entry) => {
      if (query && !entry.titleLower.includes(query)) return false;
      if (sourceFilter && !entry.sources.some(s => String(s.source || "ikiru").toLowerCase() === sourceFilter)) return false;
      return true;
    });

    $("whitelistCount").textContent = state.whitelistItems.length;

    if (!filtered.length) {
      list.innerHTML = '<li class="empty">Tidak ada hasil filter.</li>';
      return;
    }

    list.innerHTML = filtered
      .map((entry, index) => {
        const { title, sources, originalIndex } = entry;
        const displayIndex = state.whitelistSortOrder === "default" ? originalIndex : index;
        
        const isRead = sources.some(s => s.mark === "read");

        // Logic for marks (Hiatus, End, etc.)
        const marks = [...new Set(sources.map(s => s.mark).filter(m => m && m !== "read"))];
        const marksHtml = marks.length > 0 
          ? marks.map(m => `<span class="badge" style="margin-left:6px; opacity:.7">${esc(m)}</span>`).join("")
          : "";

        // Logic for source badges
        const uniqueSources = [...new Set(sources.map(s => s.source || "ikiru"))];
        const badgesHtml = uniqueSources.map(s => 
          `<span class="source-badge ${sourceBadgeClass(s)}" style="margin-right:4px">${esc(sourceName(s))}</span>`
        ).join("");

        return `<li class="manga-item">
          <span class="manga-index">${String(displayIndex + 1).padStart(2, "0")}</span>
          <span class="manga-item-title">${highlight(title, query)}${marksHtml}</span>
          <div style="display:flex; align-items:center;">${badgesHtml}</div>
          <button class="btn-mini ${isRead ? "active-red" : "active-green"}" onclick="toggleMarkReadByIndex(${originalIndex})">${isRead ? "sudah ✓" : "mark"}</button>
          <button class="btn-mini" onclick="copyWhitelistUrlByIndex(${originalIndex})">copy</button>
          <button class="btn-delete" onclick="deleteMangaByIndex(${originalIndex})">x</button>
        </li>`;
      })
      .join("");
  }

  function renderWhitelist(data) {
    state.latestWhitelistData = data ?? state.latestWhitelistData;
    state.whitelistItems = data?.items ?? [];
    applyWhitelistFilter();
  }

  function setSortOrder(order) {
    state.whitelistSortOrder = order;
    ["default", "az", "za"].forEach((value) => {
      const btn = $(`sortBtn_${value}`);
      if (btn) btn.classList.toggle("active", value === order);
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
      const key = d ? bucketKeyForDate(d) : "unknown";
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
    state.recentItems = data?.items ?? [];
    $("recentCount").textContent = state.recentItems.length;

    renderTimelineList(
      list,
      state.recentItems,
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

  function renderLogs(data) {
    state.logsItems = data?.logs ?? [];
    const list = $("logList");
    $("logCount").textContent = `${state.logsItems.length} entries`;

    renderTimelineList(
      list,
      state.logsItems,
      (log) => `<li class="log-item">
        <span class="log-time">${fmt(new Date(log.time || Date.now()))}</span>
        <span>${esc(log.message || "-")}</span>
        <span class="log-tag ${esc(log.tag || "info")}">${esc(log.tag || "info")}</span>
      </li>`,
      (log) => log.time,
    );

    renderTrendChart();
  }

  function renderRecommendations(statusData) {
    const panel = $("recommendationsPanel");
    const list = $("recommendationList");
    const countEl = $("recommendationCount");
    const items = statusData?.recommendations || [];

    if (!items.length) {
      if (panel) panel.style.display = "none";
      return;
    }

    if (panel) panel.style.display = "block";
    if (countEl) countEl.textContent = items.length;

    list.innerHTML = items
      .map((item) => {
        const reasonLabel = item.reason === "persistent_failure" ? "Mati Total" : "Stale/Lama";
        return `<li class="manga-item">
          <div class="manga-info">
            <div class="manga-item-title">${esc(item.title)}</div>
            <div class="manga-item-sub">${esc(item.url)}</div>
          </div>
          <span class="status-pill invalid">${reasonLabel}</span>
          <span class="badge">${item.consecutiveFailures}x gagal</span>
          <button class="btn-delete" onclick="deleteMangaByTitle('${esc(item.title).replace(/'/g, "\\'")}')">hapus</button>
        </li>`;
      })
      .join("");
  }

  function renderSummaryPanels() {
    renderStatsExtended(state.latestStatusData);
    renderOverview(state.latestStatusData, state.latestWhitelistData, state.latestRecentData);
    renderLastCronResult(state.latestStatusData, false);
    renderSourceHealth(state.latestStatusData);
    renderRecommendations(state.latestStatusData);
  }

  return {
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
  };
}
