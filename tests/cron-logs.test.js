import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCronErrorLog,
  classifyErrorType,
  normalizeCronLogEntry,
} from "../lib/cronLogs.js";

test("classifyErrorType recognizes common buckets", () => {
  assert.equal(classifyErrorType("Request failed with status code 403"), "discord_403");
  assert.equal(classifyErrorType("socket timeout while scraping"), "source_timeout");
  assert.equal(classifyErrorType("selector parse failed"), "source_parse");
  assert.equal(classifyErrorType("redis unavailable"), "redis_error");
});

test("normalizeCronLogEntry fills default fields", () => {
  const entry = normalizeCronLogEntry({ message: "hello" });
  assert.equal(entry.tag, "info");
  assert.equal(entry.message, "hello");
  assert.ok(entry.time);
});

test("buildCronErrorLog derives code and type", () => {
  const err = new Error("Request failed with status code 404");
  err.response = { status: 404 };

  const out = buildCronErrorLog(err, { source: "discord_send" });
  assert.equal(out.tag, "failed");
  assert.equal(out.code, "http_404");
  assert.equal(out.source, "discord_send");
  assert.ok(out.type);
});
