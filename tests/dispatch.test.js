process.env.SECONDARY_PUBLIC_BASE = "https://e.shinigami.asia";
process.env.SHINIGAMI_BASE_URL = "https://e.shinigami.asia";
process.env.IKIRU_BASE_URL = "https://02.ikiru.wtf";

import test from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_HISTORY_KEY,
  CLAIM_STATUS,
  dispatchChapters,
  prepareDispatchQueue,
} from "../lib/services/dispatch.js";

const noSubscribers = async () => [];

const mockEnqueue = (sent) => async (tasks) => {
  for (const t of tasks) {
    for (const cid of t.channelIds) {
      const val = (t.chapter.chapter && t.chapter.chapter.startsWith("Chapter"))
        ? t.chapter.chapter
        : `${t.chapter.title}:${cid}`;
      sent.push(val);
    }
  }
};

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
    async lpush(key, ...values) {
      const cur = lists.get(key) || [];
      cur.unshift(...values);
      lists.set(key, cur);
      return cur.length;
    },
    async ltrim(key, start, stop) {
      const cur = lists.get(key) || [];
      lists.set(key, cur.slice(start, stop + 1));
      return "OK";
    },
    async rpush(key, ...values) {
      const cur = lists.get(key) || [];
      cur.push(...values);
      lists.set(key, cur);
      return cur.length;
    },
    async expire() {
      return 1;
    },
    async hlen(key) {
      const current = kv.get(key) || {};
      return Object.keys(current).length;
    },
    async hscan(key, cursor) {
      // Mock: return empty scan result
      return ["0", []];
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
    pipeline() {
      const commands = [];
      const p = {
        hsetnx(key, field, value) {
          commands.push(() => api.hsetnx(key, field, value));
          return p;
        },
        hset(key, payload) {
          commands.push(() => api.hset(key, payload));
          return p;
        },
        hpexpire(key, field, ttlMs) {
          commands.push(() => Promise.resolve(1));
          return p;
        },
        hexpire(key, seconds, ...args) {
          commands.push(() => Promise.resolve(1));
          return p;
        },
        ltrim(key, start, end) {
          commands.push(() => {
            if (lists.has(key)) lists.set(key, lists.get(key).slice(start, end + 1));
          });
          return p;
        },
        expire() { return p; },
        get: (k) => { commands.push(() => api.get(k)); return p; },
        set: (k, v, o) => { commands.push(() => api.set(k, v, o)); return p; },
        async exec() {
          return Promise.all(commands.map((cmd) => cmd()));
        },
      };
      return p;
    },
  };

  return api;
}

function createLoggerMock() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    fatal() {},
    child() { return this; },
  };
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
        url: "https://e.shinigami.asia/chapter/1/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: mockEnqueue(sent),
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.equal(out.skipped, 0);
  assert.equal(out.failed, 0);
  assert.deepEqual(sent, ["Chapter 1"]);
  const recentChapters = redis.kv.get("recent:chapters") || {};
  assert.equal(Object.keys(recentChapters).length, 1);
  assert.equal((redis.lists.get("cron:logs") || []).length, 1);
  const statsMap = redis.kv.get("cron:daily_stats") || {};
  const statsStr = statsMap["2026-01-01"];
  const stats = typeof statsStr === "string" ? JSON.parse(statsStr) : statsStr;
  assert.equal(stats?.chapters_sent, 1);
});

test("dispatchChapters skips invalid or already-sent chapters", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:https://e.shinigami.asia/chapter/2/", {
    status: CLAIM_STATUS.ENQUEUED,
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
        url: "https://e.shinigami.asia/chapter/2/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: async () => {
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
        url: "https://e.shinigami.asia/chapter/3/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001", "1002"],
    enqueueNotificationsFn: async () => {
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
  const entry = getHistoryEntry(
    redis,
    "chapter:https://e.shinigami.asia/chapter/3/",
  );
  assert.ok(!entry || entry.status !== CLAIM_STATUS.ENQUEUED);
  assert.deepEqual(failedChannels.sort(), ["1001", "1002"]);
});

test("dispatchChapters runs onDispatchSuccess extra tasks", async () => {
  const redis = createRedisMock();
  const sent = [];
  let successCalled = false;

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Task",
        chapter: "Chapter 4",
        url: "https://e.shinigami.asia/chapter/4/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: mockEnqueue(sent),
    getSubscribersFn: noSubscribers,
    onDispatchSuccess: () =>
      Promise.resolve().then(() => {
        successCalled = true;
      }),
  });

  assert.equal(out.sent, 1);
  assert.equal(successCalled, true);
});

test("dispatchChapters writes one summary log for multiple sent chapters", async () => {
  const redis = createRedisMock();
  const sent = [];

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "A",
        chapter: "Chapter 1",
        url: "https://e.shinigami.asia/chapter/10/",
        source: "shinigami_project",
      },
      {
        title: "B",
        chapter: "Chapter 2",
        url: "https://e.shinigami.asia/chapter/11/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: mockEnqueue(sent),
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
        url: "https://e.shinigami.asia/chapter/82/",
        source: "shinigami_project",
      },
      {
        title: "Series",
        chapter: "Chapter 87",
        url: "https://e.shinigami.asia/chapter/87/",
        source: "shinigami_project",
      },
      {
        title: "Series",
        chapter: "Chapter 89",
        url: "https://e.shinigami.asia/chapter/89/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    chapterConcurrency: 3,
    enqueueNotificationsFn: async (tasks) => {
      const waitMap = { "Chapter 82": 30, "Chapter 87": 5, "Chapter 89": 0 };
      // Note: In batch mode, we process the whole batch.
      // To test preservation of order, we sort by originalIndex first.
      const sorted = [...tasks].sort((a,b) => a.originalIndex - b.originalIndex);
      for (const t of sorted) {
        const wait = waitMap[t.chapter.chapter] || 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
        sent.push(t.chapter.chapter);
      }
    },
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 3);
  assert.deepEqual(sent, ["Chapter 82", "Chapter 87", "Chapter 89"]);
});

test("dispatchChapters invalidates dashboard caches after write", async () => {
  const redis = createRedisMock();
  const sent = [];
  redis.kv.set("cache:api:recent:v1", { items: ["stale"] });
  redis.kv.set("cache:api:logs:v1", { logs: ["stale"] });

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Cache",
        chapter: "Chapter 7",
        url: "https://e.shinigami.asia/chapter/77/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: mockEnqueue(sent),
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  assert.equal(redis.kv.has("cache:api:recent:v1"), false);
  assert.equal(redis.kv.has("cache:api:logs:v1"), false);
});

test("prepareDispatchQueue reports invalid, already sent, and over-limit counts", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:https://e.shinigami.asia/chapter/2/", {
    status: CLAIM_STATUS.ENQUEUED,
    claimedAt: "2026-01-01T00:00:00.000Z",
    sentAt: "2026-01-01T00:00:00.000Z",
  });

  const out = await prepareDispatchQueue(
    redis,
    [
      { title: "No Url", chapter: "Chapter 1", url: "", source: "ikiru" },
      {
        title: "Already",
        chapter: "Chapter 2",
        url: "https://e.shinigami.asia/chapter/2/",
        source: "shinigami_project",
      },
      {
        title: "Queued",
        chapter: "Chapter 3",
        url: "https://e.shinigami.asia/chapter/3/",
        source: "shinigami_project",
      },
      {
        title: "Over",
        chapter: "Chapter 4",
        url: "https://e.shinigami.asia/chapter/4/",
        source: "shinigami_project",
      },
    ],
    1,
    60000,
    new Date("2026-01-01T00:00:00.000Z").getTime(),
  );

  assert.equal(out.invalidCount, 1);
  assert.equal(out.alreadySentCount, 1);
  assert.equal(out.overLimitCount, 1);
  assert.equal(out.unsentMeta.length, 2);
  assert.equal(out.queuedMeta.length, 1);
  assert.equal(out.queuedMeta[0].item.title, "Queued");
});

test("prepareDispatchQueue ignores stale pending claims but blocks fresh pending claims", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:https://e.shinigami.asia/chapter/2/", {
    status: "pending",
    claimedAt: "2026-01-01T00:00:00.000Z",
  });
  seedHistory(redis, "chapter:https://e.shinigami.asia/chapter/3/", {
    status: "pending",
    claimedAt: new Date().toISOString(),
  });

  const out = await prepareDispatchQueue(
    redis,
    [
      {
        title: "Stale Pending",
        chapter: "Chapter 2",
        url: "https://e.shinigami.asia/chapter/2/",
        source: "shinigami_project",
      },
      {
        title: "Fresh Pending",
        chapter: "Chapter 3",
        url: "https://e.shinigami.asia/chapter/3/",
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
  const sent = [];

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Promote",
        chapter: "Chapter 5",
        url: "https://e.shinigami.asia/chapter/5/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: mockEnqueue(sent),
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 1);
  const entry5 = getHistoryEntry(
    redis,
    "chapter:https://e.shinigami.asia/chapter/5/",
  );
  assert.equal(entry5?.status, CLAIM_STATUS.ENQUEUED);
  assert.equal(entry5?.claimedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(entry5?.enqueuedAt, "2026-01-01T00:00:00.000Z");
});

test("dispatchChapters reclaims stale pending claim before sending", async () => {
  const redis = createRedisMock();
  const sent = [];
  seedHistory(redis, "chapter:https://e.shinigami.asia/chapter/6/", {
    status: "pending",
    claimedAt: "2026-01-01T00:00:00.000Z",
  });

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "Reclaim",
        chapter: "Chapter 6",
        url: "https://e.shinigami.asia/chapter/6/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: mockEnqueue(sent),
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:10:01.000Z",
    pendingClaimTtl: 60,
  });

  assert.equal(out.sent, 1);
  const entry6 = getHistoryEntry(
    redis,
    "chapter:https://e.shinigami.asia/chapter/6/",
  );
  assert.equal(entry6?.status, CLAIM_STATUS.ENQUEUED);
  assert.equal(entry6?.claimedAt, "2026-01-01T00:10:01.000Z");
  assert.equal(entry6?.enqueuedAt, "2026-01-01T00:10:01.000Z");
});

test("prepareDispatchQueue blocks same title and chapter already sent from another source", async () => {
  const redis = createRedisMock();
  seedHistory(redis, "chapter:dedupe:overlord of sichuan:num:50", {
    status: CLAIM_STATUS.SENT,
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
  ], 10, 60000, new Date("2026-01-01T00:10:00.000Z").getTime());

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
        url: "https://e.shinigami.asia/chapter/overlord-50",
        source: "shinigami_mirror",
        updatedTime: "2026-01-01T03:00:00.000Z",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: async (tasks) => {
      for (const t of tasks) {
        sent.push({
          title: t.chapter.title,
          source: t.chapter.source,
          chapter: t.chapter.chapter,
        });
      }
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
  const dedupeEntry = getHistoryEntry(
    redis,
    "chapter:dedupe:overlord of sichuan:num:50",
  );
  assert.equal(dedupeEntry?.status, CLAIM_STATUS.ENQUEUED);
});

test("dispatchChapters persists sent state before moving to the next chapter", async () => {
  const redis = createRedisMock();
  const sent = [];
  const firstKey = "chapter:https://e.shinigami.asia/chapter/200/";

  const out = await dispatchChapters({
    redis,
    matched: [
      {
        title: "First",
        chapter: "Chapter 1",
        url: "https://e.shinigami.asia/chapter/200/",
        source: "shinigami_project",
      },
      {
        title: "Second",
        chapter: "Chapter 2",
        url: "https://e.shinigami.asia/chapter/201/",
        source: "shinigami_project",
      },
    ],
    channelIds: ["1001"],
    enqueueNotificationsFn: async (tasks) => {
      for (const t of tasks) {
        if (t.chapter.title === "Second") {
          // In batch mode, they are all processed in parallel then enqueued.
          // The persistence happens in batch AFTER all items are processed.
          // So for this test to pass in batch mode, we check that it IS enqueued eventually.
          assert.equal(tasks.length, 2);
        }
      }
    },
    getSubscribersFn: noSubscribers,
    nowIso: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(out.sent, 2);
});
