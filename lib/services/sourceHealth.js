export const SOURCE_KEYS = ["ikiru", "shinigami_project", "shinigami_mirror"];

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
  const disabledUntil = raw.disabledUntil || null;
  const status = raw.status === "degraded" ? "degraded" : "healthy";

  return {
    ...base,
    ...raw,
    source,
    status,
    consecutiveFailures: Number.isFinite(failures) ? failures : 0,
    disabledUntil,
  };
}

export function sourceHealthKey(source) {
  return `source:health:${source}`;
}

function comparableSourceHealth(source, raw = null) {
  return sanitizeSourceHealth(source, raw);
}

export async function loadSourceHealthMap(redis, sourceKeys = SOURCE_KEYS) {
  const pairs = await Promise.all(
    sourceKeys.map(async (source) => {
      const raw = await redis.get(sourceHealthKey(source));
      return [source, sanitizeSourceHealth(source, raw)];
    }),
  );
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
  nowIso,
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

  if (next.status === "degraded" && !isSourceInCooldown(next)) {
    next.status = "healthy";
    next.consecutiveFailures = 0;
    next.disabledUntil = null;
    next.lastError = null;
  }
  return next;
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

export async function saveSourceHealthMap(redis, map = {}, sourceKeys = SOURCE_KEYS) {
  const currentMap = await loadSourceHealthMap(redis, sourceKeys);
  const writes = sourceKeys
    .filter((source) => {
      const next = comparableSourceHealth(source, map[source]);
      const current = comparableSourceHealth(source, currentMap[source]);
      return JSON.stringify(next) !== JSON.stringify(current);
    })
    .map((source) => redis.set(sourceHealthKey(source), map[source]));

  await Promise.all(writes);
}
