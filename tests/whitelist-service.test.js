import test from "node:test";
import assert from "node:assert/strict";
import {
  findWhitelistEntryIndex,
  formatMarkedTitle,
  normalizeMarkReason,
  resolveWhitelistQuery,
  resolveWhitelistSource,
} from "../lib/services/whitelist.js";

test("normalizeMarkReason accepts supported values", () => {
  assert.equal(normalizeMarkReason("hiatus"), "hiatus");
  assert.equal(normalizeMarkReason("End Season"), "end_season");
  assert.equal(normalizeMarkReason("end"), "end");
  assert.equal(normalizeMarkReason("clear"), null);
  assert.equal(normalizeMarkReason("unknown"), null);
});

test("formatMarkedTitle appends label when mark exists", () => {
  assert.equal(
    formatMarkedTitle({ title: "Solo Leveling", mark: "end_season" }),
    "Solo Leveling [End Season]",
  );
  assert.equal(
    formatMarkedTitle({ title: "Solo Leveling", mark: null }),
    "Solo Leveling",
  );
});

test("findWhitelistEntryIndex respects source and normalized url identity", () => {
  const items = [
    { title: "Nano Machine", source: "ikiru", url: "https://02.ikiru.wtf/manga/nano-machine/" },
    { title: "Nano Machine", source: "shinigami_project", url: "https://a.shinigami.asia/series/abc" },
  ];

  assert.equal(
    findWhitelistEntryIndex(items, {
      title: "Nano Machine",
      source: "shinigami_project",
      url: "https://a.shinigami.asia/series/abc/",
    }),
    1,
  );
  assert.equal(
    findWhitelistEntryIndex(items, {
      title: "Nano Machine",
      source: "ikiru",
    }),
    0,
  );
});

test("resolveWhitelistQuery returns ambiguous matches for duplicate titles across sources", () => {
  const items = [
    { title: "Solo Leveling", source: "ikiru", url: "https://ikiru.example/solo" },
    { title: "Solo Leveling", source: "shinigami_project", url: "https://shinigami.example/solo" },
    { title: "Nano Machine", source: "ikiru", url: "https://ikiru.example/nano" },
  ];

  const result = resolveWhitelistQuery(items, "Solo Leveling");
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(
    result.matches.map(({ index, item }) => ({ index, source: item.source, title: item.title })),
    [
      { index: 0, source: "ikiru", title: "Solo Leveling" },
      { index: 1, source: "shinigami_project", title: "Solo Leveling" },
    ],
  );
});

test("resolveWhitelistQuery keeps numeric remove behavior stable", () => {
  const items = [
    { title: "Solo Leveling", source: "ikiru", url: "https://ikiru.example/solo" },
    { title: "Solo Leveling", source: "shinigami_project", url: "https://shinigami.example/solo" },
    { title: "Nano Machine", source: "ikiru", url: "https://ikiru.example/nano" },
  ];

  const result = resolveWhitelistQuery(items, "2");
  assert.equal(result.status, "matched");
  assert.equal(result.index, 1);
  assert.equal(result.item.source, "shinigami_project");
  assert.equal(result.item.title, "Solo Leveling");
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
      url: "https://a.shinigami.asia/series/abc",
      source: "ikiru",
    }),
    "shinigami_project",
  );
  assert.equal(
    resolveWhitelistSource({
      url: "https://a.shinigami.asia/series/abc",
      source: "shinigami_mirror",
    }),
    "shinigami_mirror",
  );
});
