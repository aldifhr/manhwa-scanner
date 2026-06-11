import {
  bucketKeyForDate,
  cooldownText,
  countSentLast24h,
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

    const degraded = health.status === "degraded" || health.status === "circuit_break";
    const stale = health.status === "stale" || health.isStale;
    const failures = Number(health.consecutiveFailures ?? 0);
    const inCooldown = health.disabledUntil && new Date(health.disabledUntil).getTime() > Date.now();

    let label = health.status || "healthy";
    if (inCooldown) label = "circuit break";
    else if (stale && !degraded) label = "stale";

    return {
      tone: degraded ? "degraded" : (stale ? "warning" : "healthy"),
      label,
      failures,
      extra: inCooldown
        ? cooldownText(health.disabledUntil) || "cooldown"
        : `ok${health.lastUpdateAt ? ` (updated ${timeAgo(health.lastUpdateAt)})` : ""}`,
      errorText: health.lastError || null,
      lastUpdateAt: health.lastUpdateAt,
    };
  }

  function renderTrendChart() {
    const canvas = $("chartTrend");
    const wrap = canvas?.parentElement;
    if (!canvas || !window.Chart) return;

    const rangeEl = $("chartRange");
    let range = rangeEl?.value || "24h";
    const now = new Date();
    const buckets = [];
    const sent = [];
    const skipped = [];
    const failed = [];

    function buildBuckets(r) {
      buckets.length = sent.length = skipped.length = failed.length = 0;
      if (r === "7d") {
        for (let i = 6; i >= 0; i -= 1) {
          const d = new Date(now);
          d.setDate(now.getDate() - i);
          buckets.push({
            key: bucketKeyForDate(d),
            label: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
          });
          sent.push(0); skipped.push(0); failed.push(0);
        }
        for (const log of state.logsItems) {
          const d = parseDateSafe(log?.time);
          if (!d) continue;
          const idx = buckets.findIndex((b) => b.key === bucketKeyForDate(d));
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
          sent.push(0); skipped.push(0); failed.push(0);
        }
        for (const log of state.logsItems) {
          const d = parseDateSafe(log?.time);
          if (!d) continue;
          const key = `${bucketKeyForDate(d)}-${d.getHours()}`;
          const idx = buckets.findIndex((b) => b.key === key);
          if (idx === -1) continue;
          sent[idx] += logSentCount(log);
          if (log.tag === "skipped") skipped[idx] += 1;
          failed[idx] += logFailedCount(log);
        }
      }
    }

    buildBuckets(range);

    // Auto-fallback: if 24h is empty but 7d has data, switch automatically
    const total = sent.reduce((a, b) => a + b, 0) + skipped.reduce((a, b) => a + b, 0) + failed.reduce((a, b) => a + b, 0);
    if (total === 0 && range === "24h") {
      range = "7d";
      if (rangeEl) rangeEl.value = "7d";
      buildBuckets("7d");
    }

    // Fallback: use dailyStats (from health-status API) which has proper sent/skipped/failed per day
    let totalAfterFallback = sent.reduce((a, b) => a + b, 0) + skipped.reduce((a, b) => a + b, 0) + failed.reduce((a, b) => a + b, 0);
    if (totalAfterFallback === 0 && state.dailyStats?.length) {
      for (let i = 0; i < buckets.length; i++) {
        const match = state.dailyStats.find((s) => s.date === buckets[i].key);
        if (match) {
          sent[i] = match.chaptersSent || 0;
          skipped[i] = match.chaptersSkipped || 0;
          failed[i] = (match.failedLogs || 0) + (match.deliveryFailed || 0);
        }
      }
      totalAfterFallback = sent.reduce((a, b) => a + b, 0) + skipped.reduce((a, b) => a + b, 0) + failed.reduce((a, b) => a + b, 0);
    }

    // Always overlay today's bucket with cronStatus data (most up-to-date source)
    const cronStatus = state.latestStatusData;
    if (cronStatus && (cronStatus.sent !== undefined || cronStatus.skipped !== undefined)) {
      const todayKey = bucketKeyForDate(now);
      const todayIdx = buckets.findIndex((b) => b.key === todayKey);
      if (todayIdx !== -1) {
        sent[todayIdx] = Math.max(sent[todayIdx] || 0, Number(cronStatus.sent) || 0);
        skipped[todayIdx] = Math.max(skipped[todayIdx] || 0, Number(cronStatus.skipBreakdown?.total ?? cronStatus.skipped) || 0);
        failed[todayIdx] = Math.max(failed[todayIdx] || 0, Number(cronStatus.failed) || 0);
        totalAfterFallback = sent.reduce((a, b) => a + b, 0) + skipped.reduce((a, b) => a + b, 0) + failed.reduce((a, b) => a + b, 0);
      }
    }

    // Third fallback: analytics.trends (chapters only, no skipped/failed breakdown)
    if (totalAfterFallback === 0 && state.analyticsData?.trends?.length) {
      const trends = state.analyticsData.trends;
      for (let i = 0; i < buckets.length; i++) {
        const match = trends.find((t) => t.date === buckets[i].key);
        if (match) sent[i] = match.chapters || 0;
      }
      totalAfterFallback = sent.reduce((a, b) => a + b, 0);
    }

    // --- CRITICAL FIX: Merge Recent Activity into Chart ---
    // If we see items in "Recent Activity" but they aren't in the chart yet, 
    // it's a timezone/sync issue. Let's force them into today's bucket.
    if (state.recentItems?.length > 0) {
      const todayKey = bucketKeyForDate(now);
      const todayIdx = buckets.findIndex((b) => b.key === todayKey);
      if (todayIdx !== -1) {
          const recentSentCount = state.recentItems.filter(item => {
              const d = parseDateSafe(item.sentAt || item.enqueuedAt || item.time);
              return d && bucketKeyForDate(d) === todayKey;
          }).length;
          
          if (recentSentCount > sent[todayIdx]) {
              sent[todayIdx] = recentSentCount;
              totalAfterFallback += recentSentCount;
          }
      }
    }
    // -----------------------------------------------------

    // Show placeholder if still no data after all fallbacks
    if (totalAfterFallback === 0) {
      canvas.style.display = "none";
      if (wrap && !wrap.querySelector(".chart-placeholder")) {
        const placeholder = document.createElement("div");
        placeholder.className = "chart-placeholder";
        placeholder.style.cssText = "display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:12px;font-style:italic;";
        placeholder.textContent = "Belum ada data log dalam 7 hari terakhir.";
        wrap.appendChild(placeholder);
      }
      return;
    }

    canvas.style.display = "block";
    const placeholder = wrap?.querySelector(".chart-placeholder");
    if (placeholder) placeholder.remove();

    const ctx = canvas.getContext("2d");
    const gradientSent = ctx.createLinearGradient(0, 0, 0, 400);
    gradientSent.addColorStop(0, "rgba(27, 143, 90, 0.4)");
    gradientSent.addColorStop(1, "rgba(27, 143, 90, 0)");

    const gradientSkipped = ctx.createLinearGradient(0, 0, 0, 400);
    gradientSkipped.addColorStop(0, "rgba(176, 107, 23, 0.1)");
    gradientSkipped.addColorStop(1, "rgba(176, 107, 23, 0)");

    if (state.trendChart) state.trendChart.destroy();
    state.trendChart = new window.Chart(canvas, {
      type: "line",
      data: {
        labels: buckets.map((bucket) => bucket.label),
        datasets: [
          {
            label: "sent",
            data: sent,
            borderColor: getCssVar("--green", "#1b8f5a"),
            backgroundColor: gradientSent,
            fill: true,
            borderWidth: 3,
            pointRadius: 4,
            pointBackgroundColor: getCssVar("--green", "#1b8f5a"),
            pointHoverRadius: 6,
            tension: 0.4,
            yAxisID: "y",
          },
          {
            label: "failed",
            data: failed,
            borderColor: getCssVar("--red", "#c0392b"),
            backgroundColor: "transparent",
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            tension: 0.4,
            yAxisID: "y",
          },
          {
            label: "skipped",
            data: skipped,
            borderColor: "rgba(176, 107, 23, 0.4)",
            backgroundColor: gradientSkipped,
            fill: true,
            borderWidth: 1,
            pointRadius: 0,
            tension: 0.4,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(15, 15, 15, 0.9)",
            titleFont: { size: 13, weight: "700" },
            padding: 12,
            cornerRadius: 8,
            borderColor: "rgba(255,255,255,0.1)",
            borderWidth: 1,
          }
        },
        scales: {
          y: {
            display: true,
            beginAtZero: true,
            grid: { color: "rgba(255,255,255,0.03)", drawBorder: false },
            border: { display: false },
            ticks: {
              color: "rgba(114, 103, 89, 0.5)",
              font: { family: "Geist Mono", size: 8 },
              maxTicksLimit: 5
            }
          },
          x: {
            display: true,
            grid: { display: false },
            border: { display: true, color: "rgba(114, 103, 89, 0.1)" },
            ticks: {
              color: "rgba(114, 103, 89, 0.5)",
              font: { family: "Geist Mono", size: 8 }
            }
          },
          y1: { display: false },
        },
      },
    });
  }

  function renderSourceChart() {
    const canvas = $("chartSourceHealth");
    if (!canvas || !window.Chart) return;

    // Get all configured sources from health map
    const healthMap = state.latestStatusData?.sourceHealth || {};
    const allSources = Object.keys(healthMap);

    // Count items from recent stream by source
    const recentCounts = {};
    for (const item of state.recentItems) {
      const source = String(item?.source || "ikiru").toLowerCase();
      recentCounts[source] = (recentCounts[source] || 0) + 1;
    }

    // Build sourceCounts: include all sources from health map, use recent counts if available
    const sourceCounts = {};
    if (allSources.length > 0) {
      // Use sources from health map (all configured sources)
      for (const source of allSources) {
        sourceCounts[source] = recentCounts[source] || 0;
      }
    } else {
      // Fallback: use only sources from recent items
      for (const source of Object.keys(recentCounts)) {
        sourceCounts[source] = recentCounts[source];
      }
    }

    const labels = Object.keys(sourceCounts).map((s) => sourceDisplayName(s));
    const data = Object.values(sourceCounts);

    // Distinct colors for each source
    const backgroundColors = Object.keys(sourceCounts).map((s) => {
      const id = String(s).toLowerCase();
      if (id.includes("shinigami")) return "#ef4444"; // Red
      if (id === "ikiru") return getCssVar("--green", "#1b8f5a"); // Green
      return getCssVar("--text-secondary", "#726759"); // Gray fallback
    });

    // If all counts are 0 or no data, show placeholder
    const totalUpdates = data.reduce((a, b) => a + b, 0);
    if (totalUpdates === 0 && allSources.length === 0) {
      canvas.style.display = "none";
      const placeholder = canvas.parentElement.querySelector(".chart-placeholder");
      if (placeholder) placeholder.style.display = "flex";
      return;
    }
    canvas.style.display = "block";

    // Use a small visual minimum for zero-value bars so all sources are visible
    const visualData = data.map(v => v === 0 ? 0.2 : v);
    const actualData = data; // Keep actual values for tooltips

    if (state.sourceChart) state.sourceChart.destroy();
    state.sourceChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "updates",
            data: visualData,
            backgroundColor: backgroundColors,
            borderRadius: 8,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                // Show actual value in tooltip, not the visual minimum
                const actual = actualData[ctx.dataIndex];
                return ` ${actual} chapter${actual !== 1 ? "s" : ""}`;
              }
            }
          }
        },
        scales: {
          x: { 
            display: true,
            grid: { display: false },
            border: { display: true, color: "rgba(114, 103, 89, 0.1)" },
            ticks: {
                color: "rgba(114, 103, 89, 0.5)",
                font: { family: "Geist Mono", size: 8 }
            }
          },
          y: { 
            display: false,
            beginAtZero: true 
          },
        },
      },
    });
  }

  function renderPerformanceChart() {
    const canvas = $("chartPerformance");
    const wrap = canvas?.parentElement;
    if (!canvas || !window.Chart) return;

    const providerMetrics = state.latestStatusData?.providerMetrics || [];
    const sourceHealth = state.latestStatusData?.sourceHealth || {};
    
    // Build chart data: prefer providerMetrics, fallback to sourceHealth.responseTime
    const chartData = providerMetrics.length > 0 ? providerMetrics.map(p => {
      const avgMs = p.metrics?.avgResponseTimeMs || 0;
      // Fallback: use sourceHealth responseTime if providerMetrics is zero
      const fallbackMs = sourceHealth[p.id]?.responseTime || 0;
      return {
        id: p.id,
        displayName: p.displayName,
        responseTimeMs: avgMs > 0 ? avgMs : fallbackMs,
      };
    }) : Object.entries(sourceHealth).map(([id, h]) => ({
      id,
      displayName: sourceDisplayName(id),
      responseTimeMs: (h && h.responseTime) || 0,
    }));
    
    // Check if we have actual data to show
    const hasData = chartData.some(p => p.responseTimeMs > 0);

    if (!hasData) {
      canvas.style.display = "none";
      if (wrap && !wrap.querySelector(".chart-placeholder")) {
        const placeholder = document.createElement("div");
        placeholder.className = "chart-placeholder";
        placeholder.style.cssText = "display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:12px;font-style:italic;";
        placeholder.textContent = "Menunggu data performa...";
        wrap.appendChild(placeholder);
      }
      return;
    }

    // Data exists, remove placeholder and show canvas
    const placeholder = wrap?.querySelector(".chart-placeholder");
    if (placeholder) placeholder.remove();
    canvas.style.display = "block";

    const labels = chartData.map(p => p.displayName);
    const data = chartData.map(p => p.responseTimeMs);

    const backgroundColors = chartData.map(p => {
      const id = String(p.id).toLowerCase();
      if (id.includes("shinigami")) return "#ef4444";
      if (id.includes("ikiru")) return getCssVar("--green", "#1b8f5a");
      return getCssVar("--muted", "#726759");
    });

    if (state.performanceChart) state.performanceChart.destroy();
    state.performanceChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "latency (ms)",
            data,
            backgroundColor: backgroundColors,
            borderRadius: 8,
          },
        ],
      },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { 
            display: true,
            grid: { display: false },
            border: { display: true, color: "rgba(114, 103, 89, 0.1)" },
            ticks: {
                color: "rgba(114, 103, 89, 0.5)",
                font: { family: "Geist Mono", size: 8 }
            }
          },
          y: { 
            display: true,
            grid: { display: false },
            border: { display: false },
            ticks: {
                color: "rgba(114, 103, 89, 0.7)",
                font: { family: "Geist Mono", size: 8 }
            }
          },
        },
      },
    });
  }

  function skeleton(ul, n = 4) {
    if (!ul) return;
    ul.innerHTML = Array.from(
      { length: n },
      () => "<li class=\"manga-item loading skeleton-shimmer\"></li>",
    ).join("");
  }

  function skeletonRecent(ul, n = 4) {
    if (!ul) return;
    ul.innerHTML = Array.from(
      { length: n },
      () => "<li class=\"recent-item skeleton-shimmer\" style=\"height: 64px; margin-bottom: 12px; border-radius: 12px;\"></li>",
    ).join("");
  }

  function renderErr(ul, msg) {
    ul.innerHTML = `<li class="empty">${esc(msg)} <button class="btn-mini" onclick="loadAll()">retry</button></li>`;
  }

  // Helper to normalize API response for backward compatibility
  function normalizeStatusData(statusData) {
    if (!statusData) return null;
    // Cron response format: { statusCode, body: { sent, skipped, ... } }
    // New format: { success: true, data: { sent, skipped, ... }, timestamp }
    // Old format: { sent, skipped, ... }
    return statusData.body || statusData.data || statusData;
  }
  function renderStatsExtended(statusData) {
    const dot = $("statusDot");
    const data = normalizeStatusData(statusData);
    if (!data) {
      ["statSuccessRate", "statSent", "statSkipped", "statFailed", "statDuration"].forEach(
        (id) => {
          const el = $(id);
          if (el) el.textContent = "-";
        },
      );
      if (dot) dot.className = "status-dot offline";
      return;
    }
    
    const sent = Number(data.sent || 0);
    const failed = Number(data.failed || 0);
    const total = sent + failed;
    
    // Calculate success rate
    let successRate = 100;
    let successRateClass = "green";
    if (total > 0) {
      successRate = (sent / total) * 100;
      // Color coding: green (>=95%), yellow (>=85%), red (<85%)
      if (successRate >= 95) {
        successRateClass = "green";
      } else if (successRate >= 85) {
        successRateClass = "amber";
      } else {
        successRateClass = "red";
      }
    }
    
    const successRateEl = $("statSuccessRate");
    if (successRateEl) {
      successRateEl.textContent = total > 0 ? `${successRate.toFixed(1)}%` : "100%";
      successRateEl.className = `stat-value ${successRateClass}`;
    }
    
    const statSent = $("statSent");
    if (statSent) statSent.textContent = data.sent ?? "-";
    
    const statSkipped = $("statSkipped");
    if (statSkipped) statSkipped.textContent = data.skipped ?? "-";

    const statDedupe = $("statDedupe");
    if (statDedupe) {
      const dupeCount = Number(data.skipBreakdown?.duplicate || 0);
      const sentHistory = Number(data.skipBreakdown?.alreadySentOrPending || 0);
      const staleCount = Number(data.skipBreakdown?.stale || 0);
      statDedupe.textContent = dupeCount + sentHistory + staleCount;
      statDedupe.title = `Cross-source: ${dupeCount}, History: ${sentHistory}, Stale (>24h): ${staleCount}`;
    }
    
    const statFailed = $("statFailed");
    if (statFailed) statFailed.textContent = data.failed ?? "-";
    
    const statDuration = $("statDuration");
    if (statDuration) statDuration.textContent = data.duration ? `${data.duration}s` : "-";
    

    
    if (dot) {
      const degraded = Number(data.failed || 0) > 0;
      dot.className = `brand-dot ${degraded ? "offline" : "online"}`;
    }
  }

  function renderOverview(statusData, whitelistData, recentData) {
    const healthEl = $("overviewHealth");
    const lastRunEl = $("overviewLastRun");
    const whitelistEl = $("overviewWhitelist");
    const sent24hEl = $("overviewSent24h");
    const data = normalizeStatusData(statusData);

    if (!data) {
      if (healthEl) {
        healthEl.textContent = "-";
        healthEl.className = "stat-value";
      }
      if (lastRunEl) lastRunEl.textContent = "-";
      if (whitelistEl) whitelistEl.textContent = "-";
      if (sent24hEl) sent24hEl.textContent = "-";
      const fastCronCard = $("fastCronCard");
      if (fastCronCard) fastCronCard.style.display = "none";
      return;
    }

    const sourceHealthEntries = Object.values(data.sourceHealth || {});
    const hasUnknownSource = sourceHealthEntries.some(
      (entry) => !entry || typeof entry !== "object",
    );
    const degraded =
      Number(data.failed ?? 0) > 0 ||
      sourceHealthEntries.some((entry) => entry?.status === "degraded");
    if (healthEl) {
      healthEl.textContent = degraded
        ? "DEGRADED"
        : hasUnknownSource
          ? "UNKNOWN"
          : "HEALTHY";
      healthEl.className = `stat-value ${degraded ? "amber" : hasUnknownSource ? "amber" : "green"}`;
    }

    // Get timestamp from data or fallback to latest source success
    let lastRunTimestamp = data.timestamp;
    if (!lastRunTimestamp && data.sourceHealth) {
      const healthEntries = Object.values(data.sourceHealth);
      const timestamps = healthEntries
        .map(h => h?.lastSuccessAt)
        .filter(Boolean);
      if (timestamps.length > 0) {
        lastRunTimestamp = timestamps.sort().pop(); // Get latest
      }
    }

    // Show last run time
    if (lastRunEl) lastRunEl.textContent = lastRunTimestamp ? timeAgo(lastRunTimestamp) : "-";

    // Show FastCron status in dedicated card
    const fastCronCard = $("fastCronCard");
    const fastCronEl = $("overviewFastCron");
    if (fastCronCard && fastCronEl) {
      if (data.fastCron?.nextRun?.formattedTime) {
        const responseTime = data.fastCron.latestExecution?.responseTime || "-";
        fastCronEl.innerHTML = `${data.fastCron.nextRun.formattedTime}<br><small style="font-size: 11px; opacity: 0.8;">Last: ${responseTime}</small>`;
        fastCronCard.style.display = "block";
      } else if (data.fastCron?.jobFound === false) {
        fastCronEl.textContent = "Not configured";
        fastCronCard.style.display = "block";
      } else {
        fastCronCard.style.display = "none";
      }
    }

    // Show active QStash workers badge dynamically
    const workersBadge = $("activeWorkersBadge");
    if (workersBadge) {
      if (Array.isArray(data.activeWorkers) && data.activeWorkers.length > 0) {
        workersBadge.textContent = `⚡ [${data.activeWorkers.join(", ").toUpperCase()}]`;
        workersBadge.style.display = "inline-block";
      } else {
        workersBadge.style.display = "none";
      }
    }

    // Support both direct array and wrapped items object
    const items = Array.isArray(whitelistData) ? whitelistData : (whitelistData?.items || []);
    if (whitelistEl) {
      whitelistEl.textContent = items.length > 0 ? items.length : (statusData?.whitelistCount ?? "-");
    }

    const recentRaw = Array.isArray(recentData) ? recentData : (recentData?.items || []);
    // Expand minified fields for correct date parsing
    const recentItems = recentRaw.map(item => ({
      sentAt: item.sa || item.sentAt,
      enqueuedAt: item.ea || item.enqueuedAt,
    }));
    if (sent24hEl) {
      sent24hEl.textContent = countSentLast24h(recentItems);
    }


  }

  function renderLastCronResult(statusData, fromManual = false) {
    const bar = $("lastCronBar");
    const data = normalizeStatusData(statusData);
    if (!data) {
      const els = ["lastCronSent","lastCronSkipped","lastCronDedupe","lastCronFailed","lastCronDuration"];
      els.forEach(id => { const el = $(id); if (el) el.textContent = "-"; });
      if (bar) bar.className = "hero-card";
      return;
    }

    const stateText = data.shortCircuitReason
      ? data.shortCircuitReason.replace(/_/g, " ")
      : data.outcome || "ok";

    const statSent = $("lastCronSent");
    if (statSent) statSent.textContent = data.sent ?? 0;
    
    const statSkipped = $("lastCronSkipped");
    if (statSkipped) statSkipped.textContent = data.skipped ?? 0;
    
    const statDedupe = $("lastCronDedupe") || $("statDedupe");
    if (statDedupe) {
      const dupeCount = Number(data.skipBreakdown?.duplicate || 0);
      const sentHistory = Number(data.skipBreakdown?.alreadySentOrPending || 0);
      const staleCount = Number(data.skipBreakdown?.stale || 0);
      statDedupe.textContent = `dedupe: ${dupeCount + sentHistory + staleCount}`;
    }

    const statFailedEl = $("lastCronFailed");
    if (statFailedEl) statFailedEl.textContent = data.failed ?? 0;
    
    const statDurationEl = $("statDuration");
    if (statDurationEl) statDurationEl.textContent = data.duration ? `${data.duration}s duration` : "-- duration";
    
    const timeEl = $("lastCronTime");
    if (timeEl) {
        const rawTime = data.timestamp || data.lastRun;
        if (rawTime) {
            const date = new Date(rawTime);
            timeEl.textContent = !isNaN(date.getTime()) ? fmt(date) : "--:--:--";
        } else {
            timeEl.textContent = "--:--:--";
        }
    }

    const dot = $("statusDot");
    if (dot) {
        const degraded = Number(data.failed || 0) > 0;
        dot.className = `brand-dot ${degraded ? "offline" : "online"}`;
    }

    bar.className = "hero-strip";

    // Update TopBar status text
    const topStatus = $("topStatusText");
    if (topStatus) {
        const degraded = Number(data.failed || 0) > 0;
        topStatus.textContent = degraded ? "System degraded" : "All systems operational";
        topStatus.style.color = degraded ? "var(--amber)" : "var(--green)";
        topStatus.style.opacity = "0.8";
    }
  }

  function renderSourceHealth(statusData) {
    const list = $("sourceHealthList");
    if (!list) return;
    const data = normalizeStatusData(statusData);
    const entries = Object.entries(data?.sourceHealth || {});
    const countEl = $("sourceHealthCount");

    if (!entries.length) {
      if (countEl) countEl.textContent = "0";
      list.innerHTML = `
        <li class="empty enhanced-empty">
          <span class="empty-icon">⏳</span>
          <p class="empty-title">Source health initializing</p>
          <p class="empty-subtitle">Wait for the first cron run to populate health data</p>
        </li>
      `;
      return;
    }

    // Group by display name (merge shinigami variants)
    const groups = new Map();
    for (const [source, health] of entries) {
      const name = sourceDisplayName(source);
      if (!groups.has(name)) {
        groups.set(name, { failures: 0, failuresToday: 0, successesToday: 0, responseTimes: [], worstTone: "healthy", worstLabel: "healthy", sourceCount: 0 });
      }
      const g = groups.get(name);
      const status = classifySourceHealth(health);
      const toneOrder = { degraded: 3, warning: 2, unknown: 1, healthy: 0 };
      if (toneOrder[status.tone] > toneOrder[g.worstTone]) {
        g.worstTone = status.tone;
        g.worstLabel = status.label;
      }
      g.failures += status.failures;
      g.failuresToday += health.failuresToday || 0;
      g.successesToday += health.successesToday || 0;
      if (health.responseTime != null) g.responseTimes.push(Number(health.responseTime));
      g.sourceCount++;
    }

    if (countEl) countEl.textContent = groups.size;

    let idx = 0;
    list.innerHTML = Array.from(groups.entries())
      .map(([name, g]) => {
        idx++;
        const totalToday = g.failuresToday + g.successesToday;
        const rateToday = totalToday > 0 ? Math.round((g.successesToday / totalToday) * 100) : 100;
        const avgMs = g.responseTimes.length > 0 ? Math.round(g.responseTimes.reduce((a, b) => a + b, 0) / g.responseTimes.length) : null;
        return `<li class="manga-item" style="padding: 8px 12px; display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 10px; border-bottom: 1px solid var(--border);">
          <span class="manga-index" style="font-size: 8px; opacity: 0.5;">${String(idx).padStart(2, "0")}</span>
          <div style="overflow: hidden;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 1px;">
                <span class="manga-item-title" style="font: 600 11px var(--sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(name)}${g.sourceCount > 1 ? ` <span style="opacity:0.4; font-size:8px;">(${g.sourceCount}x)</span>` : ""}</span>
                <span class="status-pill ${g.worstTone === "degraded" ? "invalid" : g.worstTone === "warning" ? "warning" : g.worstTone === "unknown" ? "" : "active"}" style="font-size: 7px; padding: 1px 4px; border-radius: 2px;">${g.worstLabel}</span>
            </div>
            <div style="font: 400 9px var(--mono); color: var(--muted); display: flex; gap: 8px;">
              <span style="display: flex; align-items: center; gap: 3px;">
                <span style="opacity: 0.6;">ms:</span>
                <span style="color:var(--text2)">${avgMs !== null ? avgMs : "-"}</span>
              </span>
              <span style="display: flex; align-items: center; gap: 3px;">
                <span style="opacity: 0.6;">stk:</span>
                <span style="color:${g.failures > 0 ? "var(--red)" : "var(--green)"}">${g.failures}</span>
              </span>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font: 600 11px var(--mono);">
               <span class="green">${g.successesToday}</span><span style="opacity:0.3; margin: 0 1px;">/</span><span class="red">${g.failuresToday}</span>
            </div>
            <div style="font: 600 8px var(--mono); color: ${rateToday < 90 ? "var(--amber)" : "var(--muted)"}; opacity: 0.7;">${rateToday}%</div>
          </div>
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

    const sourceFilter = ($("inputWhitelistSource")?.value ?? "")
      .trim()
      .toLowerCase();
    const list = $("mangaList");
    if (!list) return;

    const entries = state.whitelistItems.map((item, originalIndex) => {
      const title = typeof item === "string" ? item : item.title;
      let sources = [];
      if (
        typeof item === "object" &&
        Array.isArray(item.sources) &&
        item.sources.length > 0
      ) {
        sources = item.sources;
      } else if (typeof item === "object") {
        sources = [
          { url: item.url, source: item.source || "ikiru", mark: item.mark },
        ];
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
      if (
        sourceFilter &&
        !entry.sources.some(
          (s) => String(s.source || "ikiru").toLowerCase() === sourceFilter,
        )
      )
        return false;
      return true;
    });

    const whitelistCountEl = $("whitelistCount");
    if (whitelistCountEl) whitelistCountEl.textContent = state.whitelistItems.length;

    // Pagination
    const totalPages = Math.ceil(filtered.length / state.whitelistPageSize) || 1;
    if (state.whitelistPage > totalPages) state.whitelistPage = 1;
    const start = (state.whitelistPage - 1) * state.whitelistPageSize;
    const paged = filtered.slice(start, start + state.whitelistPageSize);

    // Update pagination UI
    const paginationEl = $("whitelistPagination");
    const pageNumbersEl = $("pageNumbers");
    const prevBtn = $("btnPrevPage");
    const nextBtn = $("btnNextPage");

    if (paginationEl) {
      if (filtered.length > state.whitelistPageSize) {
        paginationEl.style.display = "flex";
        if (prevBtn) prevBtn.disabled = state.whitelistPage <= 1;
        if (nextBtn) nextBtn.disabled = state.whitelistPage >= totalPages;

        // Render page numbers
        if (pageNumbersEl) {
          let html = "";
          const delta = 1; // Number of pages to show before/after current
          const left = state.whitelistPage - delta;
          const right = state.whitelistPage + delta;
          const range = [];
          const rangeWithDots = [];
          let l;

          for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= left && i <= right)) {
              range.push(i);
            }
          }

          for (const i of range) {
            if (l) {
              if (i - l === 2) {
                rangeWithDots.push(l + 1);
              } else if (i - l !== 1) {
                rangeWithDots.push("...");
              }
            }
            rangeWithDots.push(i);
            l = i;
          }

          pageNumbersEl.innerHTML = rangeWithDots
            .map((p) => {
              if (p === "...") return `<span class="page-ellipsis">${p}</span>`;
              return `<button type="button" class="btn-page page-num ${p === state.whitelistPage ? "active" : ""}" onclick="setWhitelistPage(${p})">${p}</button>`;
            })
            .join("");
        }
      } else {
        paginationEl.style.display = "none";
      }
    }

    if (!filtered.length) {
      const isSearching = ($("inputWhitelistSearch")?.value ?? "").trim() !== "";
      list.innerHTML = `
        <li class="empty enhanced-empty">
          <span class="empty-icon">${isSearching ? "🔍" : "📭"}</span>
          <p class="empty-title">${isSearching ? "No matches found" : "No manga in whitelist"}</p>
          <p class="empty-subtitle">${isSearching ? "Try a different search term" : "Add manga using the form above to start monitoring"}</p>
        </li>
      `;
      return;
    }

    list.innerHTML = paged
      .map((entry, index) => {
        const { title, sources, originalIndex } = entry;
        const displayIndex =
          state.whitelistSortOrder === "default" ? originalIndex : index;

        const isRead = sources.some((s) => s.mark === "read");
        
        // --- NEW: Cover & Visual Logic ---
        const firstSource = sources[0] || {};
        let coverUrl = firstSource.cover || firstSource.image || entry.item.cover || entry.item.image;
        
        // Auto-Hydration: If cover is missing, look into recent items for a match
        if (!coverUrl && state.recentItems?.length > 0) {
            const match = state.recentItems.find(r => r.title === title && r.cover);
            if (match) coverUrl = match.cover;
        }
        
        const titleInitial = (title || "?").charAt(0).toUpperCase();
        const sourceClass = (firstSource.source || "ikiru").includes("shinigami") ? "source-shinigami" : "source-ikiru";
        
        const coverHtml = coverUrl 
          ? `<img class="whitelist-cover" src="${esc(coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" /><div class="whitelist-cover-placeholder ${sourceClass}" style="display:none"><span>${titleInitial}</span></div>`
          : `<div class="whitelist-cover-placeholder ${sourceClass}"><span>${titleInitial}</span></div>`;
        // ---------------------------------

        // Logic for marks (Hiatus, End, etc.)
        const marks = [
          ...new Set(
            sources.map((s) => s.mark).filter((m) => m && m !== "read"),
          ),
        ];
        const marksHtml =
          marks.length > 0
            ? marks
              .map(
                (m) =>
                  `<span class="badge" style="margin-left:6px; opacity:.7; font-size: 10px;">${esc(m)}</span>`,
              )
              .join("")
            : "";

        // Logic for source badges
        const uniqueSources = [
          ...new Set(sources.map((s) => s.source || "ikiru")),
        ];
        const badgesHtml = uniqueSources
          .map(
            (s) =>
              `<span class="source-badge ${sourceBadgeClass(s)}" style="margin-right:4px">${esc(sourceName(s))}</span>`,
          )
          .join("");

        return `<li class="manga-item" style="padding: 10px 16px; min-height: 70px;">
          <span class="manga-index">${String(displayIndex + 1).padStart(2, "0")}</span>
          <div class="whitelist-item-content" style="display: flex; align-items: center; gap: 14px; flex: 1;">
            ${coverHtml}
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <span class="manga-item-title" style="font-weight: 700; line-height: 1.2;">${highlight(title, query)}${marksHtml}</span>
              <div style="display:flex; align-items:center;">${badgesHtml}</div>
            </div>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button class="btn-mini ${isRead ? "active-red" : "active-green"}" style="min-width: 60px;" onclick="toggleMarkReadByIndex(${originalIndex})">${isRead ? "sudah ✓" : "mark"}</button>
            <button class="btn-mini" onclick="copyWhitelistUrlByIndex(${originalIndex})">copy</button>
            <button class="btn-delete" onclick="deleteMangaByIndex(${originalIndex})">x</button>
          </div>
        </li>`;
      })
      .join("");
  }

  function renderWhitelist(data) {
    state.latestWhitelistData = data ?? state.latestWhitelistData;
    // Data can be an object with .items or a direct array from snapshot
    state.whitelistItems = Array.isArray(data) ? data : (data?.items ?? []);
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

  function renderTimelineList(ul, items, rowRenderer, getDateValue, emptyMessage = null) {
    if (!ul) return;
    if (!items.length) {
      const msg = emptyMessage || {
        icon: "📭",
        title: "No data yet",
        subtitle: "Data will appear here once available",
      };
      ul.innerHTML = `
        <li class="empty enhanced-empty">
          <span class="empty-icon">${msg.icon || "📭"}</span>
          <p class="empty-title">${msg.title || "No data yet"}</p>
          <p class="empty-subtitle">${msg.subtitle || "Data will appear here once available"}</p>
        </li>
      `;
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
    if (!list) return;
    // Expand minified field names from backend ('t'->title, 'c'->chapter, 's'->source, etc.)
    const expandMinified = (item) => ({
      title: item.t || item.title,
      chapter: item.c || item.chapter,
      url: item.u || item.url,
      cover: item.cv || item.cover,
      source: item.s || item.source,
      updatedTime: item.ut || item.updatedTime,
      sentAt: item.sa || item.sentAt,
      enqueuedAt: item.ea || item.enqueuedAt,
      sentOrder: item.so || item.sentOrder,
    });
    if (data) state.recentItems = (data.items ?? data.recentChapters ?? []).map(expandMinified);

    const filteredRecent = state.recentItems;

    const recentCountEl = $("recentCount");
    if (recentCountEl) recentCountEl.textContent = filteredRecent.length;

    renderTimelineList(
      list,
      filteredRecent,
      (item) => {
        // Better cover handling with CORS-friendly attributes and source-colored fallback
        const coverUrl = item.cover;
        const titleInitial = (item.title || "?").charAt(0).toUpperCase();
        const sourceClass = item.source?.includes("shinigami") ? "source-shinigami" : "source-ikiru";
        // Remove crossorigin to avoid strict CORS errors from external servers
        // Fallback will show automatically when image fails to load
        const coverHtml = coverUrl
          ? `<img class="recent-cover" src="${esc(coverUrl)}" alt="${esc(titleInitial)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'; this.parentElement.classList.add('cover-fallback');" /><div class="recent-cover-placeholder ${sourceClass}" style="display:none"><span style="font-size:16px;font-weight:700;color:var(--text-primary)">${titleInitial}</span></div>`
          : `<div class="recent-cover-placeholder ${sourceClass}"><span style="font-size:16px;font-weight:700;color:var(--text-primary)">${titleInitial}</span></div>`;
        const displayTime = item.sentAt || item.enqueuedAt || item.updatedTime;
        return `<a class="recent-item" href="${item.url ? esc(item.url) : "#"}" target="_blank" rel="noopener">
          ${coverHtml}
          <div class="recent-info">
            <div class="recent-title">${esc(item.title)}</div>
            <div class="recent-chapter">${esc(item.chapter || "-")} - <span class="source-badge ${sourceBadgeClass(item.source)}">${esc(sourceName(item.source))}</span></div>
          </div>
          <span class="recent-time">${displayTime ? timeAgo(displayTime) : "-"}</span>
        </a>`;
      },
      (item) => item.sentAt || item.enqueuedAt || item.updatedTime,
      {
        icon: "📚",
        title: "No chapters sent yet",
        subtitle: "Recent chapters will appear here after cron sends them",
      },
    );

    renderSourceChart();
  }

  function applyLogFilter() {
    const query = ($("inputLogSearch")?.value ?? "").trim().toLowerCase();
    const tagFilter = state.logTagFilter || "all";
    const list = $("logList");
    if (!list) return;

    const filteredLogs = state.logsItems.filter((log) => {
      // Filter by tag
      if (tagFilter !== "all" && log.tag !== tagFilter) return false;

      // Filter by search query
      if (query) {
        const message = String(log.message || "").toLowerCase();
        const tag = String(log.tag || "").toLowerCase();
        return message.includes(query) || tag.includes(query);
      }

      return true;
    });

    const logCountEl = $("logCount");
    if (logCountEl) logCountEl.textContent = `${filteredLogs.length} entries`;

    // Show last cron run status
    const lastRunNote = $("logLastRunNote");
    if (lastRunNote) {
      const cronStatus = state.latestStatusData;
      if (cronStatus && (cronStatus.sent !== undefined || cronStatus.skipped !== undefined)) {
        const sent = cronStatus.sent ?? 0;
        const skipped = cronStatus.skipped ?? 0;
        const failed = cronStatus.failed ?? 0;
        const duration = cronStatus.duration ? `${cronStatus.duration}s` : "-";
        const icon = failed > 0 ? "⚠️" : sent > 0 ? "✅" : "⏭️";
        lastRunNote.textContent = `${icon} Run terakhir: ${sent} sent, ${skipped} skipped, ${failed} failed (${duration})`;
        lastRunNote.style.display = "block";
      }
    }

    renderTimelineList(
      list,
      filteredLogs,
      (log) => {
        let message = log.message;
        if (!message) {
          if (typeof log === "string") {
            message = log;
          } else if (typeof log === "object" && log !== null) {
            if (log.type === "short_circuit") message = `Short-circuit: ${log.code || "unknown"}`;
            else if (log.action === "expand") message = `Expanding: ${log.title || log.url || "unknown"}`;
            else if (log.action === "latest") message = `Scraping latest updates...`;
            else if (log.sent !== undefined || log.skipped !== undefined || log.failed !== undefined) {
              message = `Cycle: ${log.sent ?? 0} sent, ${log.skipped ?? 0} skipped, ${log.failed ?? 0} failed`;
            }
            else message = JSON.stringify(log).substring(0, 80);
          }
        }
        
        return `<li class="log-item">
          <span class="log-time">${fmt(new Date(log.time || Date.now()))}</span>
          <span class="log-msg-text">${highlight(message || "Unknown log", query)}</span>
          <span class="log-tag ${esc(log.tag || "info")}">${esc(log.tag || "info")}</span>
        </li>`;
      },
      (log) => log.time,
      {
        icon: "📋",
        title: query || tagFilter !== "all" ? "No matching logs" : "No activity logs yet",
        subtitle: query || tagFilter !== "all" ? "Try adjusting your search or filter" : "Cron activity will be logged here",
      },
    );

    renderTrendChart();
  }

  function setLogTagFilter(tag) {
    state.logTagFilter = tag;
    
    // Update button styles
    ["all", "sent", "failed"].forEach(t => {
        const btn = $(`logFilter_${t}`);
        if (btn) {
            if (t === tag) btn.classList.add("active");
            else btn.classList.remove("active");
        }
    });
    
    applyLogFilter();
  }

  function renderLogs(data) {
    if (data) state.logsItems = data.logs ?? [];
    applyLogFilter();
  }

  function renderRecommendations(statusData) {
    const panel = $("recommendationsPanel");
    const list = $("recommendationList");
    if (!list) return;
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
        const reasonLabel =
          item.reason === "persistent_failure" ? "Mati Total" : "Stale/Lama";
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
    renderOverview(
      state.latestStatusData,
      state.latestWhitelistData,
      state.latestRecentData,
    );
    renderLastCronResult(state.latestStatusData, false);
    renderSourceHealth(state.latestStatusData);
    renderRecommendations(state.latestStatusData);
    renderPerformanceChart();
  }

  function renderQueueItems(queueLength, queueItems = []) {
    const list = $("queueList");
    const countEl = $("queueCount");

    if (!list || !countEl) return;

    const count = queueLength || 0;

    if (!queueItems || typeof queueItems !== "object") queueItems = [];
    const items = Array.isArray(queueItems) ? queueItems : Object.values(queueItems);
    countEl.textContent = `${items.length} / ${count}`;

    if (items.length === 0) {
      list.innerHTML = '<li class="empty"><span class="icon">✅</span> Tidak ada task yang tertahan. Antrean kosong.</li>';
      return;
    }

    renderTimelineList(
      list,
      items,
      (item) => {
        const cover = item?.chapter?.cover
          ? `<img class="recent-cover" src="${esc(item.chapter.cover)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="recent-cover-placeholder" style="display:none">img</div>`
          : '<div class="recent-cover-placeholder">img</div>';

        const timeBadge = item?.enqueuedAt ? `<span class="source-badge" style="background:#f59e0b;color:#000;">${timeAgo(item.enqueuedAt)}</span>` : "";
        const ch = item?.chapter?.chapter || "Unknown";

        return `<div class="recent-item" style="cursor: default">
          ${cover}
          <div class="recent-info">
            <div class="recent-title">${esc(item?.chapter?.title || "Unknown Task")}</div>
            <div class="recent-chapter">${esc(ch)} - ${timeBadge}</div>
          </div>
        </div>`;
      },
      (item) => item.enqueuedAt,
    );
  }

  function renderLiveEvents(events) {
    const body = $("liveFeedBody");
    const statusText = $("liveFeedStatus");
    if (!body) return;

    if (!Array.isArray(events) || events.length === 0) {
      body.innerHTML = '<div class="terminal-line empty">Menunggu aktivitas baru...</div>';
      if (statusText) statusText.textContent = "Listening...";
      return;
    }

    if (statusText) statusText.textContent = "Live";

    const html = events
      .map((ev) => {
        const d = new Date(ev.timestamp);
        const timeStr = d.toLocaleTimeString("id-ID", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const typeClass = `t-${ev.type || "info"}`;

        return `<div class="terminal-line">
          <span class="terminal-time">[${timeStr}]</span>
          <span class="terminal-msg ${typeClass}">${esc(ev.message)}</span>
        </div>`;
      })
      .join("");

    body.innerHTML = html;
    // Auto-scroll to top since we show newest first?
    // Actually terminal-body has column-reverse or we use normal order?
    // I used column-reverse in CSS for aesthetic but let's check.
    // If we use normal order, we should scroll to bottom.
    // Let's use normal order for natural reading and scroll to TOP if newest is at top.
    // Redis LRANGE 0 -1 returns newest first (LPUSH).
  }

  return {
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
    renderLiveEvents,
    setSortOrder,
    skeleton,
    skeletonRecent,
  };
}
