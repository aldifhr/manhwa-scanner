import test from "node:test";
import assert from "node:assert/strict";
import {
  clearDashboardLoginThrottle,
  createDashboardSessionToken,
  getClearSessionCookieHeader,
  getSessionCookieHeader,
  isCronAuthorized,
  isDashboardPasswordConfigured,
  isDashboardSessionAuthorized,
  isMonitorAuthorized,
  readDashboardLoginThrottle,
  registerDashboardLoginFailure,
  validateDashboardPassword,
} from "../lib/auth.js";

async function withEnv(patch, fn) {
  const prev = { ...process.env };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    process.env = prev;
  }
}

function createRedisMock() {
  const kv = new Map();
  const expiresAt = new Map();
  let nowMs = 0;

  const pruneExpired = () => {
    for (const [key, expiryMs] of expiresAt.entries()) {
      if (expiryMs <= nowMs) {
        kv.delete(key);
        expiresAt.delete(key);
      }
    }
  };

  return {
    kv,
    setNow(value) {
      nowMs = Number(value) || 0;
      pruneExpired();
    },
    async get(key) {
      pruneExpired();
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value, options = {}) {
      pruneExpired();
      kv.set(key, value);
      if (Number.isFinite(Number(options?.ex)) && Number(options.ex) > 0) {
        expiresAt.set(key, nowMs + Number(options.ex) * 1000);
      }
      return "OK";
    },
    async incr(key) {
      pruneExpired();
      const next = Number(kv.get(key) ?? 0) + 1;
      kv.set(key, next);
      return next;
    },
    async expire(key, seconds) {
      pruneExpired();
      if (!kv.has(key)) return 0;
      expiresAt.set(key, nowMs + Number(seconds) * 1000);
      return 1;
    },
    async ttl(key) {
      pruneExpired();
      if (!kv.has(key)) return -2;
      const expiryMs = expiresAt.get(key);
      if (!Number.isFinite(expiryMs)) return -1;
      return Math.max(0, Math.ceil((expiryMs - nowMs) / 1000));
    },
    async del(key) {
      kv.delete(key);
      expiresAt.delete(key);
      return 1;
    },
  };
}

test("validateDashboardPassword compares with DASHBOARD_PASSWORD", () =>
  withEnv({ DASHBOARD_PASSWORD: "secret-pass" }, () => {
    assert.equal(validateDashboardPassword("secret-pass"), true);
    assert.equal(validateDashboardPassword("wrong"), false);
    assert.equal(isDashboardPasswordConfigured(), true);
  }));

test("validateDashboardPassword supports typo env fallback", () =>
  withEnv(
    {
      DASHBOARD_PASSWORD: undefined,
      DASHBORD_PASSWORD: "legacy-pass",
    },
    () => {
      assert.equal(validateDashboardPassword("legacy-pass"), true);
      assert.equal(validateDashboardPassword("x"), false);
    },
  ));

test("createDashboardSessionToken + isDashboardSessionAuthorized", () =>
  withEnv(
    {
      CRON_SECRET: "cron-secret",
      DASHBOARD_SESSION_SECRET: "session-secret",
    },
    () => {
      const token = createDashboardSessionToken();
      assert.ok(token);

      const req = {
        headers: {
          cookie: `ikiru_dashboard_session=${encodeURIComponent(token)}`,
        },
      };
      assert.equal(isDashboardSessionAuthorized(req), true);
    },
  ));

test("isDashboardSessionAuthorized rejects tampered token", () =>
  withEnv(
    {
      CRON_SECRET: "cron-secret",
      DASHBOARD_SESSION_SECRET: "session-secret",
    },
    () => {
      const token = createDashboardSessionToken();
      const tampered = `${token}x`;
      const req = {
        headers: {
          cookie: `ikiru_dashboard_session=${encodeURIComponent(tampered)}`,
        },
      };
      assert.equal(isDashboardSessionAuthorized(req), false);
    },
  ));

test("isCronAuthorized accepts bearer token", () =>
  withEnv({ CRON_SECRET: "cron-secret" }, () => {
    const req = {
      headers: {
        authorization: "Bearer cron-secret",
      },
    };
    assert.equal(isCronAuthorized(req), true);
  }));

test("isMonitorAuthorized accepts dashboard session for dashboard endpoints", () =>
  withEnv(
    {
      CRON_SECRET: "cron-secret",
      DASHBOARD_SESSION_SECRET: "session-secret",
    },
    () => {
      const token = createDashboardSessionToken();
      const req = {
        headers: {
          authorization: "Bearer wrong",
          cookie: `ikiru_dashboard_session=${encodeURIComponent(token)}`,
        },
      };
      assert.equal(isMonitorAuthorized(req), true);
      assert.equal(isCronAuthorized(req), false);
    },
  ));

test("isCronAuthorized only accepts dashboard session when explicitly enabled", () =>
  withEnv(
    {
      CRON_SECRET: "cron-secret",
      DASHBOARD_SESSION_SECRET: "session-secret",
      ALLOW_DASHBOARD_CRON: "true",
    },
    () => {
      const token = createDashboardSessionToken();
      const req = {
        headers: {
          cookie: `ikiru_dashboard_session=${encodeURIComponent(token)}`,
        },
      };
      assert.equal(isCronAuthorized(req), true);
    },
  ));

test("dashboard login failures are throttled per client", async () =>
  withEnv(
    {
      DASHBOARD_LOGIN_MAX_ATTEMPTS: "2",
      DASHBOARD_LOGIN_WINDOW_SECONDS: "120",
    },
    async () => {
      const redis = createRedisMock();
      const req = { headers: { "x-forwarded-for": "1.2.3.4" } };

      redis.setNow(1000);
      const first = await registerDashboardLoginFailure(redis, req);
      assert.equal(first.count, 1);
      assert.equal(first.limited, false);

      redis.setNow(1500);
      const second = await registerDashboardLoginFailure(redis, req);
      assert.equal(second.count, 2);
      assert.equal(second.limited, true);
      assert.equal(second.retryAfterSec > 0, true);

      redis.setNow(2000);
      const snapshot = await readDashboardLoginThrottle(redis, req);
      assert.equal(snapshot.limited, true);

      await clearDashboardLoginThrottle(redis, req);
      redis.setNow(2500);
      const cleared = await readDashboardLoginThrottle(redis, req);
      assert.equal(cleared.limited, false);
      assert.equal(cleared.count, 0);
    },
  ));

test("dashboard login throttle increments atomically across concurrent failures", async () =>
  withEnv(
    {
      DASHBOARD_LOGIN_MAX_ATTEMPTS: "3",
      DASHBOARD_LOGIN_WINDOW_SECONDS: "120",
    },
    async () => {
      const redis = createRedisMock();
      const req = { headers: { "x-forwarded-for": "5.6.7.8" } };

      redis.setNow(1000);
      const counts = (await Promise.all([
        registerDashboardLoginFailure(redis, req),
        registerDashboardLoginFailure(redis, req),
        registerDashboardLoginFailure(redis, req),
      ]))
        .map((entry) => entry.count)
        .sort((left, right) => left - right);

      assert.deepEqual(counts, [1, 2, 3]);

      const snapshot = await readDashboardLoginThrottle(redis, req);
      assert.equal(snapshot.count, 3);
      assert.equal(snapshot.limited, true);
    },
  ));

test("session cookie headers include security attributes", () => {
  const reqHttps = { headers: { "x-forwarded-proto": "https" } };
  const reqHttp = { headers: { "x-forwarded-proto": "http" } };

  const setCookie = getSessionCookieHeader(reqHttps, "token-123");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);

  const clearCookie = getClearSessionCookieHeader(reqHttp);
  assert.match(clearCookie, /Max-Age=0/);
  assert.doesNotMatch(clearCookie, /Secure/);
});
