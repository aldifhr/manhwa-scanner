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

test("orchestrateScrapeSources skips source fetches when whitelist is empty", async () => {
  let cookieCalls = 0;
  let ikiruCalls = 0;
  let secondaryCalls = 0;

  const orchestrated = await orchestrateScrapeSources({
    redis: createRedisMock(),
    options: {},
    getCookie: async () => {
      cookieCalls += 1;
      return "cookie";
    },
    scrapeIkiruUpdatesWithMeta: async () => {
      ikiruCalls += 1;
      return {
        results: [],
        state: { status: "ok", count: 0, error: null, metrics: { pagesScanned: 0 } },
      };
    },
    scrapeSecondarySourceUpdates: async () => {
      secondaryCalls += 1;
      return {
        results: [],
        metrics: {
          detailAttempts: 0,
          detailSuccesses: 0,
          detailFallbacks: 0,
          detail429: 0,
          detailSkippedNonPriority: 0,
        },
      };
    },
    logger: createLoggerMock(),
  });

  assert.equal(cookieCalls, 0);
  assert.equal(ikiruCalls, 0);
  assert.equal(secondaryCalls, 0);
  assert.equal(orchestrated.items.length, 0);
  assert.equal(orchestrated.sourceStates.ikiru.status, "skipped");
  assert.equal(orchestrated.sourceStates.ikiru.error, "no whitelist titles");
  assert.equal(orchestrated.sourceStates.shinigami_project.status, "skipped");
  assert.equal(orchestrated.sourceStates.shinigami_mirror.status, "skipped");
});

test("orchestrateScrapeSources only scrapes secondary sources that have whitelist titles", async () => {
  let cookieCalls = 0;
  let ikiruCalls = 0;
  const secondaryCalls = [];

  const orchestrated = await orchestrateScrapeSources({
    redis: createRedisMock(),
    options: {
      preferredSecondaryTitles: {
        shinigami_mirror: ["Lookism"],
      },
    },
    getCookie: async () => {
      cookieCalls += 1;
      return "cookie";
    },
    scrapeIkiruUpdatesWithMeta: async () => {
      ikiruCalls += 1;
      return {
        results: [],
        state: { status: "ok", count: 0, error: null, metrics: { pagesScanned: 0 } },
      };
    },
    scrapeSecondarySourceUpdates: async (source) => {
      secondaryCalls.push(source);
      return {
        results: [
          {
            title: "Lookism",
            chapter: "Chapter 599",
            url: "https://a.shinigami.asia/chapter/abc",
            mangaUrl: "https://a.shinigami.asia/series/lookism",
            source,
            updatedTime: "2026-03-20T01:00:00.000Z",
          },
        ],
        metrics: {
          detailAttempts: 0,
          detailSuccesses: 0,
          detailFallbacks: 0,
          detail429: 0,
          detailSkippedNonPriority: 0,
        },
      };
    },
    logger: createLoggerMock(),
  });

  assert.equal(cookieCalls, 0);
  assert.equal(ikiruCalls, 0);
  assert.deepEqual(secondaryCalls, ["shinigami_mirror"]);
  assert.equal(orchestrated.items.length, 1);
  assert.equal(orchestrated.items[0].source, "shinigami_mirror");
  assert.equal(orchestrated.sourceStates.ikiru.status, "skipped");
  assert.equal(orchestrated.sourceStates.shinigami_project.status, "skipped");
  assert.equal(orchestrated.sourceStates.shinigami_project.error, "no whitelist titles");
  assert.equal(orchestrated.sourceStates.shinigami_mirror.status, "ok");
  assert.equal(orchestrated.sourceStates.shinigami_mirror.count, 1);
});
