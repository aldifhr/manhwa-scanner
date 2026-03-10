import test from "node:test";
import assert from "node:assert/strict";
import {
  createDashboardSessionToken,
  getClearSessionCookieHeader,
  getSessionCookieHeader,
  isCronAuthorized,
  isDashboardPasswordConfigured,
  isDashboardSessionAuthorized,
  validateDashboardPassword,
} from "../lib/auth.js";

function withEnv(patch, fn) {
  const prev = { ...process.env };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    process.env = prev;
  }
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

test("isCronAuthorized falls back to dashboard session", () =>
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
      assert.equal(isCronAuthorized(req), true);
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
