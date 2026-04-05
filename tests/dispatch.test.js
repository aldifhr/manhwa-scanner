process.env.SECONDARY_PUBLIC_BASE = "https://a.shinigami.asia";
process.env.SHINIGAMI_BASE_URL = "https://a.shinigami.asia";
process.env.IKIRU_BASE_URL = "https://02.ikiru.wtf";

import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchChapters,
  prepareDispatchQueue,
  DISPATCH_HISTORY_KEY,
} from "../lib/services/dispatch.js";

const noSubscribers = async () => [];

function seedHistory(redis, key, value) {
  const h = redis.kv.get(DISPATCH_HISTORY_KEY) || {};
  h[key] = typeof value === "string" ? value : JSON.stringify(value);
  redis.kv.set(DISPATCH_HISTORY_KEY, h);
}

function getHistoryEntry(redis, key) {
  const h = redis.kv.get(DISPATCH_HISTORY_KEY) || {};
  const raw = h[key];
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function createRedisMock() {
  const kv = new Map();
  const lists = new Map();

  const api = {
    kv,
    lists,
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
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
    async hset(key, fieldOrPayload, maybeValue) {
      let current = kv.get(key) || {};
      if (typeof fieldOrPayload === "object") {
        current = { ...current, ...fieldOrPayload };
      } else {
        current[fieldOrPayload] = maybeValue;
      }
      kv.set(key, current);
      return 1;
    },
    async hmget(key, ...fields) {
      const current = kv.get(key) || {};
      return fields.map((f) => (Object.hasOwn(current, f) ? current[f] : null));
    },
    async hgetall(key) {
      return kv.get(key) || {};
    },
    async hsetnx(key, field, value) {
      const current = kv.get(key) || {};
      if (Object.hasOwn(current, field)) return 0;
      current[field] = value;
      kv.set(key, current);
      return 1;
    },
    async hget(key, field) {
      const current = kv.get(key) || {};
      return Object.hasOwn(current, field) ? current[field] : null;
    },
    async hdel(key, ...fields) {
      const current = kv.get(key) || {};
      for (const f of fields) delete current[f];
      kv.set(key, current);
      return fields.length;
    },
  };

  return api;
}

test("dispatchChapters sends new chapter and writes recent entries plus daily stats", async () => {
  const redis = createRedisMock();
  const sent = [];
  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "A",
        chapter: "Chapter 1",
        url: "https://a.shinigami.asia/chapter/1/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async (item, channelId) => {
      sent.push(`${item.title}:${channelId}`);
    },
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.failed, 0);
  assert.deepEqual(sent, ["A:1001"]);
  assert.equal((redis.lists.get("recent:chapters") || []).length, 1);
  assert.equal((redis.lists.get("cron:logs") || []).length, 1);
  const statsMap = redis.kv.get("cron:daily_stats") || {};
  const statsStr = statsMap["2026-01-01"];
  const stats = typeof statsStr === "string" ? JSON.parse(statsStr) : statsStr;
  assert.equal(stats?.chapters_sent, 1);
});

test("dispatchChapters skips invalid or already-sent chapters", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:https://a.shinigami.asia/chapter/2/", {
    status: "sent",
    claimedAt: "2026-01-01T00:00:00.000Z",
    sentAt: "2026-01-01T00:00:00.000Z",
  });

  const out = await dispatchChapters({
    redis,
    matched: [
      { title: "No Url", chapter: "Chapter 1", url: "", source: "ikiru" },
      {
        title: "Already",
        chapter: "Chapter 2",
        url: "https://a.shinigami.asia/chapter/2/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {
      throw new Error("should not be called");
    },
    getSubscribersFn: noSubscribers,
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
        url: "https://a.shinigami.asia/chapter/3/",
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
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 0);
  assert.equal(out.failed, 2);
  // Lock must be released after all channels fail
  const entry = getHistoryEntry(redis, "chapter:https://a.shinigami.asia/chapter/3/");
  assert.ok(!entry || entry.status !== "sent");
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
        url: "https://a.shinigami.asia/chapter/4/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    getSubscribersFn: noSubscribers,
    onDispatchSuccess: () =>
      Promise.resolve().then(() => {
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
        url: "https://a.shinigami.asia/chapter/10/",
        source: "shinigami_project",
      },
      {
        title: "B",
        chapter: "Chapter 2",
        url: "https://a.shinigami.asia/chapter/11/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  const logs = redis.lists.get("cron:logs") || [];
  assert.equal(out.sent, 2);
  assert.equal(logs.length, 1);
  const statsMap = redis.kv.get("cron:daily_stats") || {};
  const statsStr = statsMap["2026-01-01"];
  const stats = typeof statsStr === "string" ? JSON.parse(statsStr) : statsStr;
  assert.equal(stats?.chapters_sent, 2);
});

test("dispatchChapters preserves chapter order even when later sends finish faster", async () => {
  const redis = createRedisMock();
  const sent = [];

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Series",
        chapter: "Chapter 82",
        url: "https://a.shinigami.asia/chapter/82/",
        source: "shinigami_project",
      },
      {
        title: "Series",
        chapter: "Chapter 87",
        url: "https://a.shinigami.asia/chapter/87/",
        source: "shinigami_project",
      },
      {
        title: "Series",
        chapter: "Chapter 89",
        url: "https://a.shinigami.asia/chapter/89/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    chapterConcurrency: 3,
    sendEmbed: async (item) => {
      const wait = item.chapter === "Chapter 82" ? 30 : item.chapter === "Chapter 87" ? 5 : 0;
      await new Promise((resolve) => setTimeout(resolve, wait));
      sent.push(item.chapter);
    },
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 3);
  assert.deepEqual(sent, ["Chapter 82", "Chapter 87", "Chapter 89"]);
});

test("dispatchChapters invalidates dashboard caches after write", async () => {
  const redis = createRedisMock();
  redis.kv.set("cache:api:recent:v1", { items: ["stale"] });
  redis.kv.set("cache:api:logs:v1", { logs: ["stale"] });

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Cache",
        chapter: "Chapter 7",
        url: "https://a.shinigami.asia/chapter/77/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.equal(redis.kv.has("cache:api:recent:v1"), false);
  assert.equal(redis.kv.has("cache:api:logs:v1"), false);
});

test("prepareDispatchQueue reports invalid, already sent, and over-limit counts", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:https://a.shinigami.asia/chapter/2/", {
    status: "sent",
    claimedAt: "2026-01-01T00:00:00.000Z",
    sentAt: "2026-01-01T00:00:00.000Z",
  });

  const out = await prepareDispatchQueue(redis, [
    { title: "No Url", chapter: "Chapter 1", url: "", source: "ikiru" },
    {
      title: "Already",
      chapter: "Chapter 2",
      url: "https://a.shinigami.asia/chapter/2/",
      source: "shinigami_project",
    },
    {
      title: "Queued",
      chapter: "Chapter 3",
      url: "https://a.shinigami.asia/chapter/3/",
      source: "shinigami_project",
    },
    {
      title: "Over",
      chapter: "Chapter 4",
      url: "https://a.shinigami.asia/chapter/4/",
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
  seedHistory(redis, "chapter:https://a.shinigami.asia/chapter/2/", {
    status: "pending",
    claimedAt: "2026-01-01T00:00:00.000Z",
  });
  seedHistory(redis, "chapter:https://a.shinigami.asia/chapter/3/", {
    status: "pending",
    claimedAt: new Date().toISOString(),
  });

  const out = await prepareDispatchQueue(
    redis,
    [
      {
        title: "Stale Pending",
        chapter: "Chapter 2",
        url: "https://a.shinigami.asia/chapter/2/",
        source: "shinigami_project",
      },
      {
        title: "Fresh Pending",
        chapter: "Chapter 3",
        url: "https://a.shinigami.asia/chapter/3/",
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
        url: "https://a.shinigami.asia/chapter/5/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  const entry5 = getHistoryEntry(redis, "chapter:https://a.shinigami.asia/chapter/5/");
  assert.equal(entry5?.status, "sent");
  assert.equal(entry5?.claimedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(entry5?.sentAt, "2026-01-01T00:00:00.000Z");
});

test("dispatchChapters reclaims stale pending claim before sending", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:https://a.shinigami.asia/chapter/6/", {
    status: "pending",
    claimedAt: "2026-01-01T00:00:00.000Z",
  });

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Reclaim",
        chapter: "Chapter 6",
        url: "https://a.shinigami.asia/chapter/6/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async () => {},
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:10:01.000Z",
    pendingClaimTtl: 60,
  });

  assert.equal(out.sent, 1);
  const entry6 = getHistoryEntry(redis, "chapter:https://a.shinigami.asia/chapter/6/");
  assert.equal(entry6?.status, "sent");
  assert.equal(entry6?.claimedAt, "2026-01-01T00:10:01.000Z");
  assert.equal(entry6?.sentAt, "2026-01-01T00:10:01.000Z");
});

test("prepareDispatchQueue blocks same title and chapter already sent from another source", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:dedupe:overlord of sichuan:num:50", {
    status: "sent",
    claimedAt: "2026-01-01T00:00:00.000Z",
    sentAt: "2026-01-01T00:00:00.000Z",
  });

  const out = await prepareDispatchQueue(redis, [
    {
      title: "Overlord Of Sichuan",
      chapter: "Chapter 50",
      url: "https://02.ikiru.wtf/manga/overlord-of-sichuan/chapter-50/",
      source: "ikiru",
    },
  ]);

  assert.equal(out.alreadySentCount, 1);
  assert.equal(out.unsentMeta.length, 0);
  assert.equal(out.queuedMeta.length, 0);
});

test("dispatchChapters dedupes same chapter across sources and prefers earliest update", async () => {
  const redis = createRedisMock();
  const sent = [];

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Overlord Of Sichuan",
        chapter: "Chapter 50",
        url: "https://02.ikiru.wtf/manga/overlord-of-sichuan/chapter-50/",
        source: "ikiru",
        updatedTime: "2026-01-01T01:00:00.000Z",
      },
      {
        title: "Overlord Of Sichuan",
        chapter: "Chapter 50",
        url: "https://a.shinigami.asia/chapter/overlord-50",
        source: "shinigami_mirror",
        updatedTime: "2026-01-01T03:00:00.000Z",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async (item) => {
      sent.push({ title: item.title, source: item.source, chapter: item.chapter });
    },
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T05:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.equal(out.skipped, 1);
  assert.deepEqual(sent, [
    {
      title: "Overlord Of Sichuan",
      source: "ikiru",
      chapter: "Chapter 50",
    },
  ]);
  const dedupeEntry = getHistoryEntry(redis, "chapter:dedupe:overlord of sichuan:num:50");
  assert.equal(dedupeEntry?.status, "sent");
});

test("dispatchChapters persists sent state before moving to the next chapter", async () => {
  const redis = createRedisMock();
  const firstKey = "chapter:https://a.shinigami.asia/chapter/200/";

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "First",
        chapter: "Chapter 1",
        url: "https://a.shinigami.asia/chapter/200/",
        source: "shinigami_project",
      },
      {
        title: "Second",
        chapter: "Chapter 2",
        url: "https://a.shinigami.asia/chapter/201/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    sendEmbed: async (item) => {
      if (item.title === "Second") {
        const firstEntry = getHistoryEntry(redis, firstKey);
        assert.equal(firstEntry?.status, "sent");
        assert.equal((redis.lists.get("recent:chapters") || []).length, 1);
      }
    },
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 2);
});
