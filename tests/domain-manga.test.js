import test from "node:test";
import assert from "node:assert/strict";
import {
  createWhitelistMatcher,
  getChapterNumber,
  isSameNormalizedTitle,
  normalizeTitleKey,
} from "../lib/domain.js";

test("normalizeTitleKey removes punctuation and normalizes spaces", () => {
  assert.equal(normalizeTitleKey("  Solo-Leveling!!!  "), "solo leveling");
  assert.equal(normalizeTitleKey("A   B   C"), "a b c");
});

test("isSameNormalizedTitle matches punctuation variants only", () => {
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
          url: "https://a.shinigami.asia/series/abc/",
          source: "shinigami_project",
        }
      ]
    },
  ]);

  assert.equal(
    isMatched({
      title: "Anything",
      mangaUrl: "https://a.shinigami.asia/series/abc",
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
