import test from "node:test";
import assert from "node:assert/strict";
import {
  findWhitelistEntryIndex,
  formatMarkedTitle,
  normalizeMarkReason,
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
