import test from "node:test";
import assert from "node:assert/strict";
import {
  createWhitelistMatcher,
  getChapterNumber,
  normalizeTitleKey,
} from "../lib/domain/manga.js";

test("normalizeTitleKey removes punctuation and normalizes spaces", () => {
  assert.equal(normalizeTitleKey("  Solo-Leveling!!!  "), "sololeveling");
  assert.equal(normalizeTitleKey("A   B   C"), "a b c");
});

test("getChapterNumber extracts numeric chapter", () => {
  assert.equal(getChapterNumber("Chapter 123.5"), 123.5);
  assert.equal(getChapterNumber("Ch 9"), 9);
  assert.equal(getChapterNumber("Special"), 0);
});

test("createWhitelistMatcher matches by normalized url", () => {
  const isMatched = createWhitelistMatcher([
    {
      title: "Ignored Title",
      url: "https://a.shinigami.asia/series/abc/",
      source: "shinigami_project",
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

test("createWhitelistMatcher matches by normalized title if url missing", () => {
  const isMatched = createWhitelistMatcher([
    { title: "The Beginning After The End", source: "ikiru" },
  ]);

  assert.equal(
    isMatched({
      title: "The Beginning After The End S2",
      mangaUrl: null,
      source: "ikiru",
    }),
    true,
  );
});

test("createWhitelistMatcher rejects source mismatch", () => {
  const isMatched = createWhitelistMatcher([
    { title: "Solo Leveling", source: "shinigami_project" },
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
