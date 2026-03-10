import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunChannelValidation } from "../api/cron.js";

test("shouldRunChannelValidation returns true for missing timestamp", () => {
  assert.equal(shouldRunChannelValidation(null, 3600, Date.now()), true);
  assert.equal(shouldRunChannelValidation("", 3600, Date.now()), true);
});

test("shouldRunChannelValidation returns false before refresh window", () => {
  const now = Date.now();
  const last = new Date(now - 5 * 60 * 1000).toISOString();
  assert.equal(shouldRunChannelValidation(last, 3600, now), false);
});

test("shouldRunChannelValidation returns true after refresh window", () => {
  const now = Date.now();
  const last = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  assert.equal(shouldRunChannelValidation(last, 3600, now), true);
});
