import test from "node:test";
import assert from "node:assert/strict";

process.env.UPSTASH_REDIS_REST_URL = "https://mock-redis.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";

const {
  findWhitelistEntryIndex,
  markWhitelistEntry,
  removeWhitelistEntry,
  resolveWhitelistQuery,
  resolveWhitelistSource,
  formatMarkedTitle,
  addWhitelistEntry, // Import here to avoid multiple dynamic imports everywhere
} = await import("../lib/services/whitelist.js");
const { normalizeMarkReason } = await import("../lib/domain.js");

test("normalizeMarkReason accepts supported values", () => {
  assert.equal(normalizeMarkReason("hiatus"), "hiatus");
  assert.equal(normalizeMarkReason("End Season"), "end_season");
  assert.equal(normalizeMarkReason("end"), "end");
  assert.equal(normalizeMarkReason("clear"), null);
  assert.equal(normalizeMarkReason("unknown"), null);
});

test("formatMarkedTitle appends label when mark exists", () => {
  // Now item has mark or sources
  assert.equal(
    formatMarkedTitle({ title: "Solo Leveling", mark: "end_season" }),
    "Solo Leveling [Selesai Season]",
  );
  assert.equal(
    formatMarkedTitle({ title: "Solo Leveling", mark: null }),
    "Solo Leveling",
  );
});

test("findWhitelistEntryIndex respects nested sources", () => {
  const items = [
    { 
      title: "Nano Machine", 
      sources: [
        { source: "ikiru", url: "https://02.ikiru.wtf/manga/nano-machine/" }
      ]
    },
    { 
      title: "Solo Leveling", 
      sources: [
        { source: "shinigami_project", url: "https://a.shinigami.asia/series/abc/" }
      ]
    },
  ];

  assert.equal(
    findWhitelistEntryIndex(items, {
      title: "Solo Leveling",
      source: "shinigami_project",
      url: "https://a.shinigami.asia/series/abc/",
    }),
    1,
  );
  assert.equal(
    findWhitelistEntryIndex(items, {
      title: "Nano Machine",
    }),
    0,
  );
});

test("resolveWhitelistQuery handles consolidated titles", () => {
  const items = [
    { 
      title: "Solo Leveling", 
      sources: [
        { source: "ikiru", url: "https://ikiru.example/solo" },
        { source: "shinigami_project", url: "https://shinigami.example/solo" }
      ]
    },
    { 
      title: "Nano Machine", 
      sources: [
        { source: "ikiru", url: "https://ikiru.example/nano" }
      ]
    },
  ];

  const result = resolveWhitelistQuery(items, "Solo Leveling");
  assert.equal(result.status, "matched");
  assert.equal(result.index, 0);
  assert.equal(result.item.title, "Solo Leveling");
});

test("resolveWhitelistQuery keeps numeric remove behavior stable", () => {
  const items = [
    { title: "Solo Leveling", sources: [{ source: "ikiru" }] },
    { title: "Nano Machine", sources: [{ source: "ikiru" }] },
  ];

  const result = resolveWhitelistQuery(items, "2");
  assert.equal(result.status, "matched");
  assert.equal(result.index, 1);
  assert.equal(result.item.title, "Nano Machine");
});

test("resolveWhitelistSource aligns source with canonical url", () => {
  assert.equal(
    resolveWhitelistSource({
      url: "https://02.ikiru.wtf/manga/nano-machine/",
      source: "shinigami_project",
    }),
    "ikiru",
  );
  assert.equal(
    resolveWhitelistSource({
      url: "https://a.shinigami.asia/series/abc/",
      source: "ikiru",
    }),
    "shinigami_project",
  );
  assert.equal(
    resolveWhitelistSource({
      url: "https://a.shinigami.asia/series/abc/",
      source: "shinigami_mirror",
    }),
    "shinigami_mirror",
  );
});

test("removeWhitelistEntry handles nested items", async () => {
  let saveCalls = 0;
  const result = await removeWhitelistEntry("Solo Leveling", {
    loadWhitelistFn: async () => ([
      { title: "Solo Leveling", sources: [{ source: "ikiru" }] },
    ]),
    saveWhitelistFn: async (items) => {
      saveCalls += 1;
      assert.equal(items.length, 0);
    },
    redisClient: { del: async () => 0, hdel: async () => 0, hgetall: async () => ({}), hset: async () => 1 },
  });

  assert.equal(result.status, "removed");
  assert.equal(saveCalls, 1);
});

test("markWhitelistEntry marks all sources", async () => {
  let savedItems = null;
  const items = [
    { title: "Solo Leveling", sources: [{ source: "ikiru", mark: null }, { source: "shinigami", mark: null }] },
  ];

  const result = await markWhitelistEntry("Solo Leveling", "hiatus", {
    loadWhitelistFn: async () => items.map((item) => ({ ...item })),
    saveWhitelistFn: async (nextItems) => {
      savedItems = nextItems;
    },
    redisClient: { del: async () => 0 },
  });

  assert.equal(result.status, "updated");
  assert.equal(savedItems[0].sources[0].mark, "hiatus");
  assert.equal(savedItems[0].sources[1].mark, "hiatus");
});

test("resolveWhitelistQuery finds matches with minor typos (fuzzy)", () => {
  const items = [
    { title: "Solo Leveling", sources: [] },
    { title: "Nano Machine", sources: [] },
  ];

// "Solo Levling" (missing 'e')
  const result = resolveWhitelistQuery(items, "Solo Levling");
  assert.equal(result.status, "matched");
  assert.equal(result.suggested, true);
  assert.equal(result.item.title, "Solo Leveling");

  // "Nanomachin" (missing 'e', no space)
  const result2 = resolveWhitelistQuery(items, "Nanomachin");
  assert.equal(result2.status, "matched");
  assert.equal(result2.suggested, true);
  assert.equal(result2.item.title, "Nano Machine");
});

test("addWhitelistEntry prevents fuzzy title duplicates", async () => {
  const mockWhitelist = [
    { title: "Nano Machine", sources: [{ source: "ikiru" }] },
  ];
  
  const result = await addWhitelistEntry({
    title: "Nanomachin", // Slight variation
    source: "ikiru"
  }, {
    loadWhitelistFn: async () => mockWhitelist,
    saveWhitelistFn: async () => {}, // Mock to prevent hitting real Redis
    redisClient: { 
      set: async () => "OK",
      mget: async () => [],
      del: async () => 0,
      hdel: async () => 0,
      hgetall: async () => ({}),
      hset: async () => 1
    }
  });

  assert.equal(result.status, "exists");
});
