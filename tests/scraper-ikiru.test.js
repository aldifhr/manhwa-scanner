import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import {
  collectIkiruRecentChaptersFromAjaxHtml,
  collectIkiruRecentChaptersFromMangaPage,
  shouldBreakIkiruLatestScan,
} from "../lib/scrapers/ikiru.js";

test("collectIkiruRecentChaptersFromMangaPage reads full series chapter list within 24h", () => {
  const freshA = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const freshB = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const html = `
    <html>
      <body>
        <ul class="eplister">
          <li>
            <a href="/the-emperors-sword/chapter-89/"><p>Chapter 89</p></a>
            <time datetime="${freshA}"></time>
          </li>
          <li>
            <a href="/the-emperors-sword/chapter-88/"><p>Chapter 88</p></a>
            <time datetime="${freshB}"></time>
          </li>
          <li>
            <a href="/the-emperors-sword/chapter-87/"><p>Chapter 87</p></a>
            <time datetime="${stale}"></time>
          </li>
        </ul>
      </body>
    </html>
  `;
  const $ = cheerio.load(html);

  const out = collectIkiruRecentChaptersFromMangaPage(
    $,
    "https://02.ikiru.wtf/manga/the-emperors-sword/",
    {
      title: "The Emperor's Sword",
      cover: "https://cdn.example/cover.jpg",
      rating: "7/10",
      status: "Ongoing",
    },
  );

  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((item) => item.chapter),
    ["Chapter 89", "Chapter 88"],
  );
  assert.match(out[0].url, /chapter-89/i);
  assert.equal(out[0].source, "ikiru");
});

test("collectIkiruRecentChaptersFromMangaPage respects seen chapter keys", () => {
  const fresh = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const html = `
    <ul class="eplister">
      <li>
        <a href="/the-emperors-sword/chapter-89/"><p>Chapter 89</p></a>
        <time datetime="${fresh}"></time>
      </li>
    </ul>
  `;
  const $ = cheerio.load(html);
  const seen = new Set(["The Emperor's Sword-Chapter 89"]);

  const out = collectIkiruRecentChaptersFromMangaPage(
    $,
    "https://02.ikiru.wtf/manga/the-emperors-sword/",
    { title: "The Emperor's Sword" },
    seen,
  );

  assert.equal(out.length, 0);
});

test("collectIkiruRecentChaptersFromAjaxHtml reads multiple fresh chapters from chapter_list response", () => {
  const freshA = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const freshB = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const freshC = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const stale = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  const html = `
    <div id="chapter-list">
      <div data-chapter-number="89">
        <a href="https://02.ikiru.wtf/manga/the-emperors-sword/chapter-89.824441/">
          <span>Chapter 89</span>
          <time datetime="${freshA}">1 hour ago</time>
        </a>
      </div>
      <div data-chapter-number="88">
        <a href="https://02.ikiru.wtf/manga/the-emperors-sword/chapter-88.824440/">
          <span>Chapter 88</span>
          <time datetime="${freshB}">1 hour ago</time>
        </a>
      </div>
      <div data-chapter-number="87">
        <a href="https://02.ikiru.wtf/manga/the-emperors-sword/chapter-87.824438/">
          <span>Chapter 87</span>
          <time datetime="${freshC}">1 hour ago</time>
        </a>
      </div>
      <div data-chapter-number="86">
        <a href="https://02.ikiru.wtf/manga/the-emperors-sword/chapter-86.824435/">
          <span>Chapter 86</span>
          <time datetime="${stale}">2 days ago</time>
        </a>
      </div>
    </div>
  `;

  const out = collectIkiruRecentChaptersFromAjaxHtml(
    html,
    "https://02.ikiru.wtf/manga/the-emperors-sword/",
    {
      title: "The Emperor's Sword",
      cover: "https://cdn.example/cover.jpg",
      rating: "7/10",
      status: "Ongoing",
    },
  );

  assert.equal(out.results.length, 4);
  assert.equal(out.foundOlderThan24h, true);
  assert.deepEqual(out.results.map((item) => item.chapter), [
    "Chapter 89",
    "Chapter 88",
    "Chapter 87",
    "Chapter 86",
  ]);
});

test("shouldBreakIkiruLatestScan stops after consecutive stale pages", () => {
  assert.equal(
    shouldBreakIkiruLatestScan({
      emptyPageStreak: 0,
      stalePageStreak: 1,
    }),
    false,
  );

  assert.equal(
    shouldBreakIkiruLatestScan({
      emptyPageStreak: 0,
      stalePageStreak: 2,
    }),
    true,
  );

  assert.equal(
    shouldBreakIkiruLatestScan({
      emptyPageStreak: 1,
      stalePageStreak: 0,
    }),
    true,
  );
});
