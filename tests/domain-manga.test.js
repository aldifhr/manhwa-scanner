import test from "node:test";
import assert from "node:assert/strict";
import {
  compactTitleKey,
  createWhitelistMatcher,
  getChapterNumber,
  isSameNormalizedTitle,
  normalizeTitleKey,
  getShinigamiPublicBase,
} from "../lib/domain.js";

const shigBase = getShinigamiPublicBase();

test("compactTitleKey removes all spaces and punctuation for strict deduplication", () => {
  assert.equal(compactTitleKey("Full-Time Awakening"), "fulltimeawakening");
  assert.equal(compactTitleKey("Full Time Awakening"), "fulltimeawakening");
  assert.equal(compactTitleKey("FullTimeAwakening"), "fulltimeawakening");
});

test("normalizeTitleKey removes punctuation but preserves internal spaces", () => {
  assert.equal(normalizeTitleKey("  Solo-Leveling!!!  "), "solo leveling");
  assert.equal(normalizeTitleKey("A   B   C"), "a b c");
});

test("isSameNormalizedTitle matches across punctuation variants using compact keys", () => {
  assert.equal(isSameNormalizedTitle("Full-Time Awakening", "Full Time Awakening"), true);
  assert.equal(isSameNormalizedTitle("Solo-Leveling", "Solo Leveling"), true);
  assert.equal(isSameNormalizedTitle("The Beginning After The End", "The Beginning After The End S2"), false);
});

test("getChapterNumber extracts numeric chapter", () => {
  assert.equal(getChapterNumber("Chapter 123.5"), 123.5);
  assert.equal(getChapterNumber("Ch 9"), 9);
  assert.equal(getChapterNumber("Special"), 0);
});

test("createWhitelistMatcher matches by normalized url in sources", () => {
  const isMatched = createWhitelistMatcher([
    {
      title: "Ignored Title",
      sources: [
        {
          url: `${shigBase}/series/abc/`,
          source: "shinigami_project",
        },
      ],
    },
  ]);

  assert.equal(
    isMatched({
      title: "Anything",
      mangaUrl: `${shigBase}/series/abc`,
      source: "shinigami",
    }),
    true,
  );
});

test("createWhitelistMatcher matches exact normalized title if url missing", () => {
  const isMatched = createWhitelistMatcher([
    { title: "Solo-Leveling", sources: [{ source: "ikiru" }] },
  ]);

  assert.equal(
    isMatched({
      title: "Solo Leveling",
      mangaUrl: null,
      source: "ikiru",
    }),
    true,
  );
});

test("createWhitelistMatcher rejects partial title matches if url missing", () => {
  const isMatched = createWhitelistMatcher([
    { title: "The Beginning After The End", sources: [{ source: "ikiru" }] },
  ]);

  assert.equal(
    isMatched({
      title: "The Beginning After The End S2",
      mangaUrl: null,
      source: "ikiru",
    }),
    false,
  );
});

test("createWhitelistMatcher rejects source mismatch", () => {
  const isMatched = createWhitelistMatcher([
    { title: "Solo Leveling", sources: [{ source: "shinigami_project" }] },
  ]);

  assert.equal(
    isMatched({
      title: "Solo Leveling",
      mangaUrl: null,
      source: "ikiru",
    }),
    false,
  );
});
