import test from "node:test";
import assert from "node:assert/strict";
import {
  inferSourceFromUrl,
  normalizeSource,
  normalizeSourceUrl,
  sourceLabel,
  getShinigamiPublicBase,
} from "../lib/domain.js";

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
  const shigBase = getShinigamiPublicBase();
  assert.equal(
    normalizeSourceUrl("https://shngm.id/series/abc/"),
    `${shigBase}/series/abc/`,
  );
  assert.equal(
    normalizeSourceUrl("http://www.shinigami.asia/series/abc"),
    `${shigBase}/series/abc/`,
  );
});

test("normalizeSourceUrl lowercases and trims trailing slash", () => {
  const shigBase = getShinigamiPublicBase();
  assert.equal(
    normalizeSourceUrl(`${shigBase.toUpperCase()}/SERIES/ABC/`),
    `${shigBase}/series/abc/`,
  );
});


test("inferSourceFromUrl detects canonical source from url", () => {
  assert.equal(
    inferSourceFromUrl("https://02.ikiru.wtf/manga/nano-machine/"),
    "ikiru",
  );
  assert.equal(
    inferSourceFromUrl(`${getShinigamiPublicBase()}/series/abc/`),
    "shinigami_project",
  );
  assert.equal(inferSourceFromUrl("https://example.com/series/abc"), null);
});
