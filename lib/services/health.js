import axios from "axios";
import pLimit from "p-limit";
import crypto from "crypto";
import { redis, loadWhitelist } from "../redis.js";

const CONCURRENCY_LIMIT = 5;
export const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];

/**
 * --- Part 1: Link Health checking (Batch & Single) ---
 */

export async function checkSingleLink(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  try {
    const res = await axios.head(url, {
      timeout: 10000,
      headers,
      validateStatus: (status) => status < 400,
    });
    return { url, status: res.status, ok: true };
  } catch {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers,
        validateStatus: () => true,
      });
      const isOk = res.status >= 200 && res.status < 400;
      return { url, status: res.status, ok: isOk };
    } catch (e) {
      return {
        url,
        status: e.code || "TIMEOUT/ERROR",
        ok: false,
        message: e.message,
      };
    }
  }
}

export const HEALTH_STATS_KEY = "health:stats:data";

export function linkStatsHash(url) {
  return crypto.createHash("md5").update(url).digest("hex");
}

export async function updateLinkStats(url, ok, status) {
  const hash = linkStatsHash(url);
  const now = new Date().toISOString();

  const rawCache = await redis.hget(HEALTH_STATS_KEY, hash);
  const raw = typeof rawCache === "string" ? JSON.parse(rawCache) : rawCache;

  const stats = raw || {
    url,
    consecutiveFailures: 0,
    totalFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastStatusCode: null,
  };

  if (ok) {
    if (raw) {
      await redis.hdel(HEALTH_STATS_KEY, hash);
    }
    stats.consecutiveFailures = 0;
    stats.lastSuccessAt = now;
    return stats;
  } else {
    stats.consecutiveFailures = (stats.consecutiveFailures || 0) + 1;
    stats.totalFailures = (stats.totalFailures || 0) + 1;
    stats.lastFailureAt = now;
    stats.lastStatusCode = status;
    stats.expiresAt = Date.now() + 86400 * 7 * 1000; // 7 days expiration tracking

    await redis.hset(HEALTH_STATS_KEY, { [hash]: JSON.stringify(stats) });
    return stats;
  }
}

export async function performFullHealthCheck() {
  const whitelist = await loadWhitelist();
  if (!Array.isArray(whitelist)) return [];

  const allLinks = [];
  whitelist.forEach((item) => {
    item.sources?.forEach((s) => {
      if (s.url) {
        allLinks.push({ title: item.title, url: s.url, source: s.source });
      }
    });
  });

  const limit = pLimit(CONCURRENCY_LIMIT);
  const results = await Promise.all(
    allLinks.map((link) =>
      limit(async () => {
        const res = await checkSingleLink(link.url);
        const stats = await updateLinkStats(link.url, res.ok, res.status);
        return { ...link, ...res, stats };
      }),
    ),
  );

  const brokenLinks = results.filter((r) => !r.ok);
  const recommendations = results
    .filter((r) => {
      const s = r.stats;
      const isPersistent = s.consecutiveFailures >= 5;
      const hoursSinceSuccess = s.lastSuccessAt
        ? (Date.now() - new Date(s.lastSuccessAt).getTime()) / 3600000
        : 168; // 7 days if never successful
      const isStale = hoursSinceSuccess >= 168; // 7 days
      return !r.ok && (isPersistent || isStale);
    })
    .map((r) => ({
      title: r.title,
      url: r.url,
      reason:
        r.stats.consecutiveFailures >= 5
          ? "persistent_failure"
          : "stale_failure",
      consecutiveFailures: r.stats.consecutiveFailures,
      lastSuccessAt: r.stats.lastSuccessAt,
    }));

  // Cleanup expired items from hash
  try {
    const allFields = await redis.hgetall(HEALTH_STATS_KEY);
    if (allFields && typeof allFields === "object") {
      const toDelete = [];
      const nowMs = Date.now();
      for (const [hash, statStr] of Object.entries(allFields)) {
        try {
          const stat =
            typeof statStr === "string" ? JSON.parse(statStr) : statStr;
          if (stat && stat.expiresAt && stat.expiresAt < nowMs) {
            toDelete.push(hash);
          }
        } catch (_err) {
          /* ignore */
        }
      }
      if (toDelete.length > 0) {
        await redis.hdel(HEALTH_STATS_KEY, ...toDelete);
      }
    }
  } catch (err) {
    console.error("[performFullHealthCheck] err cleaning up health hash:", err);
  }

  await redis.set("health:broken-links", brokenLinks);
  await redis.set("health:recommendations", recommendations);
  await redis.set("health:last-check", new Date().toISOString());

  return brokenLinks;
}

/**
 * --- Part 2: Scraper Source Health & Cooldown ---
 */

export const SOURCES_HEALTH_KEY = "sources:health";
export const sourceHealthKey = (source) => `source:health:${source}`;

export function defaultSourceHealth(source) {
  return {
    source,
    status: "healthy",
    consecutiveFailures: 0,
    disabledUntil: null,
    lastError: null,
    lastSuccessAt: null,
    lastCheckedAt: null,
  };
}

export function sanitizeSourceHealth(source, raw = null) {
  const base = defaultSourceHealth(source);
  if (!raw || typeof raw !== "object") return base;

  const failures = Number(raw.consecutiveFailures || 0);
  const status = raw.status === "degraded" ? "degraded" : "healthy";

  return {
    ...base,
    ...raw,
    source,
    status,
    consecutiveFailures: Number.isFinite(failures) ? failures : 0,
  };
}

export async function loadSourceHealthMap(
  redisObj = redis,
  sourceKeys = SOURCE_KEYS,
) {
  const dbData = (await redisObj.hgetall(SOURCES_HEALTH_KEY)) || {};
  const pairs = sourceKeys.map((source) => {
    let raw = dbData[source];
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        /* ignore */
      }
    }
    return [source, sanitizeSourceHealth(source, raw)];
  });
  return Object.fromEntries(pairs);
}

export function isSourceInCooldown(health, nowMs = Date.now()) {
  if (!health?.disabledUntil) return false;
  const disabledMs = new Date(health.disabledUntil).getTime();
  return Number.isFinite(disabledMs) && disabledMs > nowMs;
}

export function applySourceOutcome(
  current,
  outcome,
  nowIso = new Date().toISOString(),
  { failureThreshold = 3, cooldownSeconds = 1800 } = {},
) {
  const next = { ...current, lastCheckedAt: nowIso };
  const outcomeStatus = outcome?.status || "ok";

  if (outcomeStatus === "error") {
    const failures = Number(next.consecutiveFailures || 0) + 1;
    const isDegraded = failures >= failureThreshold;
    next.consecutiveFailures = failures;
    next.status = isDegraded ? "degraded" : "healthy";
    next.lastError = outcome.error || "unknown error";
    next.disabledUntil = isDegraded
      ? new Date(Date.now() + cooldownSeconds * 1000).toISOString()
      : null;
    return next;
  }

  if (outcomeStatus === "ok") {
    next.status = "healthy";
    next.consecutiveFailures = 0;
    next.disabledUntil = null;
    next.lastError = null;
    next.lastSuccessAt = nowIso;
    return next;
  }

  return next;
}

export async function saveSourceHealthMap(
  redisObj = redis,
  map = {},
  sourceKeys = SOURCE_KEYS,
) {
  const payload = {};
  for (const source of sourceKeys) {
    payload[source] = JSON.stringify(sanitizeSourceHealth(source, map[source]));
  }
  if (Object.keys(payload).length > 0) {
    await redisObj.hset(SOURCES_HEALTH_KEY, payload);
  }
}

export function getDisabledSources(sourceHealthMap, sourceKeys = SOURCE_KEYS) {
  return sourceKeys.filter((source) =>
    isSourceInCooldown(sourceHealthMap?.[source]),
  );
}

export function buildNextSourceHealthMap({
  sourceKeys = SOURCE_KEYS,
  currentMap = {},
  sourceStates = {},
  nowIso = new Date().toISOString(),
  failureThreshold = 3,
  cooldownSeconds = 1800,
} = {}) {
  const next = {};

  for (const source of sourceKeys) {
    const current = currentMap[source] || defaultSourceHealth(source);
    const outcome = sourceStates?.[source] || { status: "ok" };
    next[source] = applySourceOutcome(current, outcome, nowIso, {
      failureThreshold,
      cooldownSeconds,
    });
  }

  return next;
}
