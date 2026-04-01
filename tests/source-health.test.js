import test from "node:test";
import assert from "node:assert/strict";
import {
  applySourceOutcome,
  buildNextSourceHealthMap,
  defaultSourceHealth,
  getDisabledSources,
  isSourceInCooldown,
  loadSourceHealthMap,
  sanitizeSourceHealth,
  saveSourceHealthMap,
  sourceHealthKey,
} from "../lib/services/health.js";

test("defaultSourceHealth returns healthy baseline", () => {
  const out = defaultSourceHealth("ikiru");
  assert.equal(out.source, "ikiru");
  assert.equal(out.status, "healthy");
  assert.equal(out.consecutiveFailures, 0);
  assert.equal(out.disabledUntil, null);
});

test("sanitizeSourceHealth normalizes invalid values", () => {
  const out = sanitizeSourceHealth("ikiru", {
    status: "unknown",
    consecutiveFailures: "abc",
    disabledUntil: "x",
  });
  assert.equal(out.status, "healthy");
  assert.equal(out.consecutiveFailures, 0);
  assert.equal(out.disabledUntil, "x");
});

test("applySourceOutcome marks source degraded after threshold", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const current = {
    ...defaultSourceHealth("ikiru"),
    consecutiveFailures: 2,
  };

  const out = applySourceOutcome(
    current,
    { status: "error", error: "boom" },
    nowIso,
    { failureThreshold: 3, cooldownSeconds: 60 },
  );

  assert.equal(out.status, "degraded");
  assert.equal(out.consecutiveFailures, 3);
  assert.equal(out.lastError, "boom");
  assert.ok(out.disabledUntil);
});

test("applySourceOutcome resets health on success", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const current = {
    ...defaultSourceHealth("ikiru"),
    status: "degraded",
    consecutiveFailures: 4,
    disabledUntil: "2027-01-01T00:00:00.000Z",
    lastError: "oops",
  };

  const out = applySourceOutcome(current, { status: "ok" }, nowIso);
  assert.equal(out.status, "healthy");
  assert.equal(out.consecutiveFailures, 0);
  assert.equal(out.disabledUntil, null);
  assert.equal(out.lastError, null);
  assert.equal(out.lastSuccessAt, nowIso);
});

test("isSourceInCooldown checks disabledUntil", () => {
  const now = Date.now();
  assert.equal(
    isSourceInCooldown({
      disabledUntil: new Date(now + 30_000).toISOString(),
    }, now),
    true,
  );
  assert.equal(
    isSourceInCooldown({
      disabledUntil: new Date(now - 30_000).toISOString(),
    }, now),
    false,
  );
});

test("buildNextSourceHealthMap applies outcomes for each source", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const out = buildNextSourceHealthMap({
    sourceKeys: ["ikiru", "shinigami_project"],
    currentMap: {
      ikiru: defaultSourceHealth("ikiru"),
      shinigami_project: defaultSourceHealth("shinigami_project"),
    },
    sourceStates: {
      ikiru: { status: "ok" },
      shinigami_project: { status: "error", error: "timeout" },
    },
    nowIso,
    failureThreshold: 1,
    cooldownSeconds: 30,
  });

  assert.equal(out.ikiru.status, "healthy");
  assert.equal(out.shinigami_project.status, "degraded");
});

test("getDisabledSources returns sources currently in cooldown", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const out = getDisabledSources(
    {
      ikiru: { disabledUntil: future },
      shinigami_project: { disabledUntil: past },
    },
    ["ikiru", "shinigami_project"],
  );
  assert.deepEqual(out, ["ikiru"]);
});

test("loadSourceHealthMap and saveSourceHealthMap use redis keys correctly", async () => {
  const store = new Map();
  let setCount = 0;
  let getCount = 0;
  const redis = {
    async get(key) {
      getCount += 1;
      return store.get(key) ?? null;
    },
    async set(key, value) {
      setCount += 1;
      store.set(key, value);
      return "OK";
    },
  };

  await saveSourceHealthMap(
    redis,
    {
      ikiru: {
        source: "ikiru",
        status: "degraded",
        consecutiveFailures: 1,
        lastError: "timeout",
      },
    },
    ["ikiru"],
  );

  const loaded = await loadSourceHealthMap(redis, ["ikiru"]);
  assert.equal(loaded.ikiru.source, "ikiru");
  assert.equal(loaded.ikiru.status, "degraded");
  assert.equal(sourceHealthKey("ikiru"), "source:health:ikiru");
  await saveSourceHealthMap(
    redis,
    {
      ikiru: {
        source: "ikiru",
        status: "degraded",
        consecutiveFailures: 1,
        lastError: "timeout",
      },
    },
    ["ikiru"],
    loaded,
  );
  assert.equal(setCount, 2);
  assert.equal(getCount, 1);
});
