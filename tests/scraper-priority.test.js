import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldPrioritizeSecondaryEntry,
  shouldPrioritizeSecondaryTitle,
} from "../lib/scraper.js";

test("shouldPrioritizeSecondaryTitle defaults to true when no preferred set", () => {
  assert.equal(shouldPrioritizeSecondaryTitle("Nano Machine", null), true);
  assert.equal(shouldPrioritizeSecondaryTitle("Nano Machine", new Set()), true);
});

test("shouldPrioritizeSecondaryTitle matches exact normalized titles only", () => {
  const preferred = new Set(["nano machine", "return of the devourer"]);
  assert.equal(shouldPrioritizeSecondaryTitle("Nano Machine", preferred), true);
  assert.equal(shouldPrioritizeSecondaryTitle("Return of the Devourer!!!", preferred), true);
  assert.equal(shouldPrioritizeSecondaryTitle("Return of the Devourer S2", preferred), false);
  assert.equal(shouldPrioritizeSecondaryTitle("Some Other Series", preferred), false);
});

test("shouldPrioritizeSecondaryEntry can fall back to canonical manga url", () => {
  const preferred = {
    titleKeys: new Set(["lookism"]),
    urlKeys: new Set(["https://a.shinigami.asia/series/lookism/"]),
  };

  assert.equal(
    shouldPrioritizeSecondaryEntry(
      {
        title: "Lookism Season 2",
        mangaUrl: "https://shngm.id/series/lookism/",
      },
      preferred,
    ),
    true,
  );
  assert.equal(
    shouldPrioritizeSecondaryEntry(
      {
        title: "Lookism Season 2",
        mangaUrl: "https://a.shinigami.asia/series/other-series/",
      },
      preferred,
    ),
    false,
  );
});
