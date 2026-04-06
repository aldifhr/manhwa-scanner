import test from "node:test";
import assert from "node:assert/strict";
import { runCronJob } from "../lib/cronRuntime.js";

function createRedisMock() {
  const kv = new Map();
  const lists = new Map();
  const hashes = new Map();

  return {
    async get(key) {
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      kv.set(key, value);
      return "OK";
    },
    async del(key) {
      kv.delete(key);
      lists.delete(key);
      hashes.delete(key);
      return 1;
    },
    async mget(...keys) {
      return keys.map((key) => kv.get(key) ?? null);
    },
    async lpush(key, value) {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    },
    async ltrim(key, start, stop) {
      const list = lists.get(key) ?? [];
      lists.set(key, list.slice(start, stop + 1));
      return "OK";
    },
    async lrange(key, start, stop) {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop + 1);
    },
    async expire() {
      return 1;
    },
    async hgetall(key) {
      const hash = hashes.get(key);
      if (!hash) return {};
      return Object.fromEntries(hash);
    },
    async hset(key, fieldValues) {
      if (!hashes.has(key)) {
        hashes.set(key, new Map());
      }
      const hash = hashes.get(key);
      for (const [field, value] of Object.entries(fieldValues)) {
        hash.set(
          field,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }
      return 1;
    },
    async hget(key, field) {
      const hash = hashes.get(key);
      if (!hash) return null;
      return hash.get(field) || null;
    },
    async hmget(key, ...fields) {
      const hash = hashes.get(key);
      if (!hash) return fields.map(() => null);
      return fields.map((f) => hash.get(f) || null);
    },
    async hsetnx(key, field, value) {
      if (!hashes.has(key)) {
        hashes.set(key, new Map());
      }
      const hash = hashes.get(key);
      if (hash.has(field)) {
        return 0; // Field already exists
      }
      hash.set(
        field,
        typeof value === "string" ? value : JSON.stringify(value),
      );
      return 1; // Field was set
    },
  };
}

function createLoggerMock() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test("runCronJob includes per-step timing metrics in success status", async () => {
  const redis = createRedisMock();

  const result = await runCronJob({
    redisClient: redis,
    logger: createLoggerMock(),
    loadWhitelistFn: async () => [
      {
        title: "Lookism",
        sources: [
          {
            source: "shinigami_mirror",
            url: "https://a.shinigami.asia/series/lookism",
          },
        ],
      },
    ],
    getAllGuildChannelsFn: async () => ({
      guild1: "123456789012345678",
    }),
    scrapeMangaUpdatesWithMetaFn: async () => ({
      items: [
        {
          title: "Lookism",
          chapter: "Chapter 599",
          url: "https://a.shinigami.asia/chapter/lookism-599",
          mangaUrl: "https://a.shinigami.asia/series/lookism",
          source: "shinigami_mirror",
          updatedTime: "2026-03-20T01:00:00.000Z",
        },
      ],
      sourceStates: {
        ikiru: {
          status: "skipped",
          count: 0,
          error: "no whitelist titles",
          metrics: null,
        },
        shinigami_project: {
          status: "skipped",
          count: 0,
          error: "no whitelist titles",
          metrics: null,
        },
        shinigami_mirror: {
          status: "ok",
          count: 1,
          error: null,
          metrics: { detailAttempts: 0 },
        },
      },
    }),
    sendEmbed: async () => true,
    validateDiscordChannelFn: async () => true,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.timingMetrics);
  assert.equal(typeof result.body.timingMetrics.loadInputsMs, "number");
  assert.equal(typeof result.body.timingMetrics.channelValidationMs, "number");
  assert.equal(typeof result.body.timingMetrics.scrapeMs, "number");
  assert.equal(typeof result.body.timingMetrics.sourceHealthWriteMs, "number");
  assert.equal(typeof result.body.timingMetrics.matchFilterMs, "number");
  assert.equal(typeof result.body.timingMetrics.dispatchMs, "number");
  assert.equal(typeof result.body.timingMetrics.totalMs, "number");
  assert.ok(
    result.body.timingMetrics.totalMs >= result.body.timingMetrics.dispatchMs,
  );

  const savedStatusRaw = await redis.get("cron:last_run");
  const savedStatus =
    typeof savedStatusRaw === "string"
      ? JSON.parse(savedStatusRaw)
      : savedStatusRaw;
  assert.ok(savedStatus?.timingMetrics);
  assert.equal(
    savedStatus.timingMetrics.totalMs,
    result.body.timingMetrics.totalMs,
  );
});
