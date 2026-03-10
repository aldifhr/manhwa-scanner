import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSource,
  normalizeSourceUrl,
  sourceLabel,
} from "../lib/domain/source.js";

test("normalizeSource normalizes known aliases", () => {
  assert.equal(normalizeSource("mirror"), "shinigami_mirror");
  assert.equal(normalizeSource("shinigami"), "shinigami_project");
  assert.equal(normalizeSource("project"), "shinigami_project");
  assert.equal(normalizeSource("ikiru"), "ikiru");
});

test("normalizeSource defaults unknown source to ikiru", () => {
  assert.equal(normalizeSource("unknown-source"), "ikiru");
  assert.equal(normalizeSource(""), "ikiru");
});

test("sourceLabel returns human-readable label", () => {
  assert.equal(sourceLabel("shinigami_project"), "Shinigami (Project)");
  assert.equal(sourceLabel("shinigami_mirror"), "Shinigami (Mirror)");
  assert.equal(sourceLabel("ikiru"), "Ikiru");
});

test("normalizeSourceUrl normalizes shngm and shinigami domains", () => {
  assert.equal(
    normalizeSourceUrl("https://shngm.id/series/abc/"),
    "https://a.shinigami.asia/series/abc",
  );
  assert.equal(
    normalizeSourceUrl("http://www.shinigami.asia/series/abc"),
    "https://a.shinigami.asia/series/abc",
  );
});

test("normalizeSourceUrl lowercases and trims trailing slash", () => {
  assert.equal(
    normalizeSourceUrl("HTTPS://A.SHINIGAMI.ASIA/SERIES/ABC/"),
    "https://a.shinigami.asia/series/abc",
  );
});
