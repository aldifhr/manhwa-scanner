import test from "node:test";
import assert from "node:assert/strict";
import { shouldPrioritizeSecondaryTitle } from "../lib/scraper.js";

test("shouldPrioritizeSecondaryTitle defaults to true when no preferred set", () => {
  assert.equal(shouldPrioritizeSecondaryTitle("Nano Machine", null), true);
  assert.equal(shouldPrioritizeSecondaryTitle("Nano Machine", new Set()), true);
});

test("shouldPrioritizeSecondaryTitle matches normalized and partial titles", () => {
  const preferred = new Set(["nano machine", "return of the devourer"]);
  assert.equal(shouldPrioritizeSecondaryTitle("Nano Machine", preferred), true);
  assert.equal(shouldPrioritizeSecondaryTitle("Return of the Devourer S2", preferred), true);
  assert.equal(shouldPrioritizeSecondaryTitle("Some Other Series", preferred), false);
});
