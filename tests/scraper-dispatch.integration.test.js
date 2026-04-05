import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateScrapeSources } from "../lib/scrapers/orchestrator.js";
import { createWhitelistMatcher } from "../lib/domain.js";
import { prepareDispatchQueue } from "../lib/services/dispatch.js";

function createRedisMock() {
  const kv = new Map();
  const hashes = new Map(); // key -> Map(field -> value)

  function getHash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  }

  return {
    kv,
    hashes,
    async mget(...keys) {
      return keys.map((key) => (kv.has(key) ? kv.get(key) : null));
    },
    async get(key) {
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      kv.set(key, value);
      return "OK";
    },
    async hmget(key, ...fields) {
      const hash = getHash(key);
      return fields.map((f) => hash.get(f) ?? null);
    },
    async hget(key, field) {
      return getHash(key).get(field) ?? null;
    },
    async hset(key, obj) {
      const hash = getHash(key);
      for (const [f, v] of Object.entries(obj)) hash.set(f, v);
      return Object.keys(obj).length;
    },
    async hsetnx(key, field, value) {
      const hash = getHash(key);
      if (hash.has(field)) return 0;
      hash.set(field, value);
      return 1;
    },
    async hdel(key, ...fields) {
      const hash = getHash(key);
      let deleted = 0;
      for (const f of fields) { if (hash.delete(f)) deleted++; }
      return deleted;
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

test("Ikiru whitelist flow narrows orchestration results before dispatch queueing", async () => {
  const redis = createRedisMock();
  // Seed chapter-88 as already sent in the dispatch:history hash (current format).
  // Key format: "chapter:" + normalizeSourceUrl(url) → keeps scheme + trailing slash.
  const sentPayload = JSON.stringify({ status: "sent", claimedAt: new Date().toISOString(), sentAt: new Date().toISOString(), expiresAt: Date.now() + 86400000 });
  await redis.hset("dispatch:history", {
    "chapter:https://02.ikiru.wtf/manga/the-emperors-sword/chapter-88.824440/": sentPayload,
  });

  const orchestrated = await orchestrateScrapeSources({
    redis,
    options: {
      preferredIkiruTitles: ["The Emperor's Sword"],
    },
    getCookie: async () => "cookie",
    scrapeIkiruUpdatesWithMeta: async () => ({
      results: [
        {
          title: "The Emperor's Sword",
          chapter: "Chapter 88",
          url: "https://02.ikiru.wtf/manga/the-emperors-sword/chapter-88.824440/",
          mangaUrl: "https://02.ikiru.wtf/manga/the-emperors-sword/",
          source: "ikiru",
          updatedTime: "2026-03-12T08:33:04.000Z",
        },
        {
          title: "The Emperor's Sword",
          chapter: "Chapter 89",
          url: "https://02.ikiru.wtf/manga/the-emperors-sword/chapter-89.824441/",
          mangaUrl: "https://02.ikiru.wtf/manga/the-emperors-sword/",
          source: "ikiru",
          updatedTime: "2026-03-12T08:34:01.000Z",
        },
        {
          title: "Some Other Series",
          chapter: "Chapter 10",
          url: "https://02.ikiru.wtf/manga/some-other-series/chapter-10.555/",
          mangaUrl: "https://02.ikiru.wtf/manga/some-other-series/",
          source: "ikiru",
          updatedTime: "2026-03-12T08:40:00.000Z",
        },
      ],
      state: {
        status: "ok",
        count: 3,
        error: null,
        metrics: { pagesScanned: 1 },
      },
    }),
    scrapeSecondarySourceUpdates: async () => ({
      results: [],
      metrics: {
        detailAttempts: 0,
        detailSuccesses: 0,
        detailFallbacks: 0,
        detail429: 0,
        detailSkippedNonPriority: 0,
      },
    }),
    logger: createLoggerMock(),
  });

  const whitelist = [
    {
      title: "The Emperor's Sword",
      sources: [
        {
          source: "ikiru",
          url: "https://02.ikiru.wtf/manga/the-emperors-sword/",
        }
      ]
    },
  ];
  const matched = orchestrated.items.filter(createWhitelistMatcher(whitelist));
  const queue = await prepareDispatchQueue(redis, matched);

  assert.equal(orchestrated.items.length, 3);
  assert.deepEqual(
    matched.map((item) => item.chapter),
    ["Chapter 88", "Chapter 89"],
  );
  assert.equal(queue.alreadySentCount, 1);
  assert.equal(queue.unsentMeta.length, 1);
  assert.equal(queue.queuedMeta[0].item.chapter, "Chapter 89");
});
