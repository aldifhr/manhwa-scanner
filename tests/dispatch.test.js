import test from "node:test";
import assert from "node:assert/strict";
import { dispatchChapters } from "../lib/services/dispatch.js";

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
