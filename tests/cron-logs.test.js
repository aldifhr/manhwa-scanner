import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCronDailyStats,
  appendCronLog,
  buildCronErrorLog,
  classifyErrorType,
  cronDailyStatsKey,
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

function createRedisMock() {
  const kv = new Map();
  const lists = new Map();
  return {
    kv,
    lists,
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value, opts = {}) {
      if (opts?.nx && kv.has(key)) return null;
      kv.set(key, value);
      return "OK";
    },
    async del(key) {
      kv.delete(key);
      return 1;
    },
    async lpush(key, value) {
      const current = lists.get(key) || [];
      current.unshift(value);
      lists.set(key, current);
      return current.length;
    },
    async ltrim(key, start, stop) {
      const current = lists.get(key) || [];
      lists.set(key, current.slice(start, stop + 1));
      return "OK";
    },
    async expire() {
      return 1;
    },
  };
}

test("appendCronLogThrottled skips repeated info logs within throttle window", async () => {
  const { appendCronLogThrottled } = await import("../lib/cronLogs.js");
  const redis = createRedisMock();

  const first = await appendCronLogThrottled(redis, {
    tag: "info",
    code: "no_new_chapters",
    type: "short_circuit",
    source: "cron",
    message: "Cron found no new chapters.",
  }, 1800);
  const second = await appendCronLogThrottled(redis, {
    tag: "info",
    code: "no_new_chapters",
    type: "short_circuit",
    source: "cron",
    message: "Cron found no new chapters.",
  }, 1800);

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal((redis.lists.get("cron:logs") || []).length, 1);
});

test("appendCronLog keeps sent summaries out of raw list but aggregates daily stats", async () => {
  const redis = createRedisMock();
  const written = await appendCronLog(redis, {
    time: "2026-03-20T10:00:00.000Z",
    tag: "sent",
    code: "dispatch_sent",
    type: "delivery_summary",
    source: "dispatch",
    count: 3,
    message: "Cron sent 3 chapter(s)",
  });

  assert.equal(written, false);
  assert.equal((redis.lists.get("cron:logs") || []).length, 0);
  assert.deepEqual(redis.kv.get(cronDailyStatsKey("2026-03-20T10:00:00.000Z")), {
    events_total: 1,
    "tag:sent": 1,
    "code:dispatch_sent": 1,
    "type:delivery_summary": 1,
    "source:dispatch": 1,
    chapters_sent: 3,
  });
});

test("appendCronDailyStats aggregates failed delivery counts", async () => {
  const redis = createRedisMock();
  await appendCronDailyStats(redis, {
    time: "2026-03-20T11:00:00.000Z",
    tag: "partial",
    code: "dispatch_partial",
    type: "delivery_summary",
    source: "dispatch",
    count: 2,
    failed: 1,
    message: "Cron sent 2 chapter(s) | failed=1",
  });

  assert.deepEqual(redis.kv.get(cronDailyStatsKey("2026-03-20T11:00:00.000Z")), {
    events_total: 1,
    "tag:partial": 1,
    "code:dispatch_partial": 1,
    "type:delivery_summary": 1,
    "source:dispatch": 1,
    chapters_sent: 2,
    delivery_failed: 1,
  });
});

test("readCronDailyStats returns compact monthly summaries", async () => {
  const { readCronDailyStats } = await import("../lib/cronLogs.js");
  const redis = createRedisMock();
  redis.kv.set("cron:stats:2026-03-19", { events_total: 2, "tag:sent": 1, chapters_sent: 4 });
  redis.kv.set("cron:stats:2026-03-20", { events_total: 1, "type:short_circuit": 1 });

  const out = await readCronDailyStats(redis, 2, new Date("2026-03-20T12:00:00.000Z"));

  assert.deepEqual(out, [
    {
      date: "2026-03-19",
      runs: 2,
      sentLogs: 1,
      partialLogs: 0,
      failedLogs: 0,
      shortCircuits: 0,
      chaptersSent: 4,
      deliveryFailed: 0,
    },
    {
      date: "2026-03-20",
      runs: 1,
      sentLogs: 0,
      partialLogs: 0,
      failedLogs: 0,
      shortCircuits: 1,
      chaptersSent: 0,
      deliveryFailed: 0,
    },
  ]);
});
