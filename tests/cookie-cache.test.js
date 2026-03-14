import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldBackoffCookieRefresh,
  shouldReuseCachedCookie,
} from "../lib/scrapers/shared.js";

test("shouldReuseCachedCookie rejects missing timestamp", () => {
  assert.equal(shouldReuseCachedCookie(null, 3600, Date.now()), false);
  assert.equal(shouldReuseCachedCookie("", 3600, Date.now()), false);
  assert.equal(shouldReuseCachedCookie("not-a-number", 3600, Date.now()), false);
});

test("shouldReuseCachedCookie accepts recently refreshed cookie", () => {
  const now = Date.now();
  assert.equal(shouldReuseCachedCookie(String(now - 5 * 60 * 1000), 3600, now), true);
});

test("shouldReuseCachedCookie expires stale cookie", () => {
  const now = Date.now();
  assert.equal(shouldReuseCachedCookie(String(now - 7 * 60 * 60 * 1000), 3600, now), false);
});

test("shouldBackoffCookieRefresh only during active cooldown", () => {
  const now = Date.now();
  assert.equal(shouldBackoffCookieRefresh(now + 30_000, now), true);
  assert.equal(shouldBackoffCookieRefresh(now - 1, now), false);
  assert.equal(shouldBackoffCookieRefresh("invalid", now), false);
});
