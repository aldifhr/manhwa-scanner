import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchChapters,
  prepareDispatchQueue,
} from "../lib/services/dispatch.js";

function createRedisMock() {
  const kv = new Map();
  const lists = new Map();

  const api = {
    kv,
    lists,
    async mget(...keys) {
      return keys.map((k) => (kv.has(k) ? kv.get(k) : null));
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
      const cur = lists.get(key) || [];
      cur.unshift(value);
      lists.set(key, cur);
      return cur.length;
    },
    async ltrim(key, start, stop) {
      const cur = lists.get(key) || [];
      lists.set(key, cur.slice(start, stop + 1));
      return "OK";
    },
    async expire() {
      return 1;
    },
  };

  return api;
}

test("dispatchChapters sends new chapter and writes recent/log entries", async () => {
  const redis = createRedisMock();
  const sent = [];
  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "A",
        chapter: "Chapter 1",
        url: "https://a.shinigami.asia/chapter/1",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async (item, channelId) => {
      sent.push(`${item.title}:${channelId}`);
    },
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.failed, 0);
  assert.deepEqual(sent, ["A:1001"]);
  assert.equal((redis.lists.get("recent:chapters") || []).length, 1);
  assert.equal((redis.lists.get("cron:logs") || []).length, 1);
});

test("dispatchChapters skips invalid or already-sent chapters", async () => {
  const redis = createRedisMock();
  redis.kv.set("chapter:https://a.shinigami.asia/chapter/2", "sent");

  const out = await dispatchChapters({
    redis,
    matched: [
      { title: "No Url", chapter: "Chapter 1", url: "", source: "ikiru" },
      {
        title: "Already",
        chapter: "Chapter 2",
        url: "https://a.shinigami.asia/chapter/2",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {
      throw new Error("should not be called");
    },
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 0);
  assert.equal(out.skipped, 2);
  assert.equal(out.failed, 0);
});

test("dispatchChapters releases lock if all channels fail", async () => {
  const redis = createRedisMock();
  const failedChannels = [];

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Fail",
        chapter: "Chapter 3",
        url: "https://a.shinigami.asia/chapter/3",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001", "1002"],
    sendEmbed: async () => {
      throw new Error("discord down");
    },
    onChannelError: async (_err, channelId) => {
      failedChannels.push(channelId);
    },
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 0);
  assert.equal(out.failed, 2);
  assert.equal(redis.kv.has("chapter:https://a.shinigami.asia/chapter/3"), false);
  assert.deepEqual(failedChannels.sort(), ["1001", "1002"]);
});

test("dispatchChapters runs onDispatchSuccess extra tasks", async () => {
  const redis = createRedisMock();
  let executed = 0;

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Task",
        chapter: "Chapter 4",
        url: "https://a.shinigami.asia/chapter/4",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    onDispatchSuccess: () => Promise.resolve().then(() => {
      executed += 1;
    }),
  });

  assert.equal(out.sent, 1);
  assert.equal(executed, 1);
});

test("dispatchChapters writes one summary log for multiple sent chapters", async () => {
  const redis = createRedisMock();

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "A",
        chapter: "Chapter 1",
        url: "https://a.shinigami.asia/chapter/10",
        source: "shinigami_project",
      },
      {
        title: "B",
        chapter: "Chapter 2",
        url: "https://a.shinigami.asia/chapter/11",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  const logs = redis.lists.get("cron:logs") || [];
  assert.equal(out.sent, 2);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0]?.message || ""), /Cron sent 2 chapter\(s\)/);
});

test("dispatchChapters invalidates dashboard caches after write", async () => {
  const redis = createRedisMock();
  redis.kv.set("cache:api:recent:v1", { items: ["stale"] });
  redis.kv.set("cache:api:logs:v1", { logs: ["stale"] });
  redis.kv.set("cache:api:source-compare:v1", { comparisons: ["stale"] });

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Cache",
        chapter: "Chapter 7",
        url: "https://a.shinigami.asia/chapter/77",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.equal(redis.kv.has("cache:api:recent:v1"), false);
  assert.equal(redis.kv.has("cache:api:logs:v1"), false);
  assert.equal(redis.kv.has("cache:api:source-compare:v1"), false);
});

test("prepareDispatchQueue reports invalid, already sent, and over-limit counts", async () => {
  const redis = createRedisMock();
  redis.kv.set("chapter:https://a.shinigami.asia/chapter/2", "sent");

  const out = await prepareDispatchQueue(redis, [
    { title: "No Url", chapter: "Chapter 1", url: "", source: "ikiru" },
    {
      title: "Already",
      chapter: "Chapter 2",
      url: "https://a.shinigami.asia/chapter/2",
      source: "shinigami_project",
    },
    {
      title: "Queued",
      chapter: "Chapter 3",
      url: "https://a.shinigami.asia/chapter/3",
      source: "shinigami_project",
    },
    {
      title: "Over",
      chapter: "Chapter 4",
      url: "https://a.shinigami.asia/chapter/4",
      source: "shinigami_project",
    },
  ], 1);

  assert.equal(out.invalidCount, 1);
  assert.equal(out.alreadySentCount, 1);
  assert.equal(out.overLimitCount, 1);
  assert.equal(out.unsentMeta.length, 2);
  assert.equal(out.queuedMeta.length, 1);
  assert.equal(out.queuedMeta[0].item.title, "Queued");
});

test("prepareDispatchQueue ignores stale pending claims but blocks fresh pending claims", async () => {
  const redis = createRedisMock();
  redis.kv.set("chapter:https://a.shinigami.asia/chapter/2", {
    status: "pending",
    claimedAt: "2026-01-01T00:00:00.000Z",
  });
  redis.kv.set("chapter:https://a.shinigami.asia/chapter/3", {
    status: "pending",
    claimedAt: new Date().toISOString(),
  });

  const out = await prepareDispatchQueue(
    redis,
    [
      {
        title: "Stale Pending",
        chapter: "Chapter 2",
        url: "https://a.shinigami.asia/chapter/2",
        source: "shinigami_project",
      },
      {
        title: "Fresh Pending",
        chapter: "Chapter 3",
        url: "https://a.shinigami.asia/chapter/3",
        source: "shinigami_project",
      },
    ],
    Infinity,
    60 * 1000,
  );

  assert.equal(out.alreadySentCount, 1);
  assert.equal(out.unsentMeta.length, 1);
  assert.equal(out.queuedMeta[0].item.title, "Stale Pending");
});

test("dispatchChapters promotes successful pending claim to sent state", async () => {
  const redis = createRedisMock();

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Promote",
        chapter: "Chapter 5",
        url: "https://a.shinigami.asia/chapter/5",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.deepEqual(redis.kv.get("chapter:https://a.shinigami.asia/chapter/5"), {
    status: "sent",
    claimedAt: "2026-01-01T00:00:00.000Z",
    sentAt: "2026-01-01T00:00:00.000Z",
  });
});
