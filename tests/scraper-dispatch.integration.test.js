import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateScrapeSources } from "../lib/scrapers/orchestrator.js";
import { createWhitelistMatcher } from "../lib/domain/manga.js";
import { prepareDispatchQueue } from "../lib/services/dispatch.js";

function createRedisMock() {
  const kv = new Map();

  return {
    kv,
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
  redis.kv.set("chapter:https://02.ikiru.wtf/manga/the-emperors-sword/chapter-88.824440", "sent");

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
      source: "ikiru",
      url: "https://02.ikiru.wtf/manga/the-emperors-sword/",
    },
  ];
  const matched = orchestrated.items.filter(createWhitelistMatcher(whitelist));
  const queue = await prepareDispatchQueue(redis, matched);

  assert.equal(orchestrated.items.length, 3);
  assert.deepEqual(
    matched.map((item) => item.chapter),
    ["Chapter 89", "Chapter 88"],
  );
  assert.equal(queue.alreadySentCount, 1);
  assert.equal(queue.unsentMeta.length, 1);
  assert.equal(queue.queuedMeta[0].item.chapter, "Chapter 89");
});
