
import { createWhitelistMatcher } from "../lib/domain.js";
import { normalizeTitleKey, normalizeChapterIdentity } from "../lib/domain.js";

// Mock version of buildCrossSourceChapterKey for the test
function buildCrossSourceChapterKey(item) {
  const titleKey = normalizeTitleKey(item?.canonicalTitle || item?.title || "");
  const chapterKey = normalizeChapterIdentity(item?.chapter || "");
  if (!titleKey || !chapterKey) return null;
  return `chapter:dedupe:${titleKey}:${chapterKey}`;
}

const whitelist = [
  { title: "Solo Max-Level Newbie" },
  { title: "Only I Have An EX-Grade Summon" },
];

console.log("=== SIMULASI DEDUPLIKASI CANONICAL TITLE ===\n");

const matcher = createWhitelistMatcher(whitelist);

const scenarios = [
  {
    name: "Scenario 1: Judul Sama Persis",
    items: [
      { title: "Solo Max-Level Newbie", chapter: "Chapter 150", source: "ikiru" },
      { title: "Solo Max-Level Newbie", chapter: "Chapter 150", source: "shinigami" },
    ],
  },
  {
    name: "Scenario 2: Judul Berbeda Sedikit (Ada tambahan nama sumber)",
    items: [
      { title: "Only I Have An EX-Grade Summon", chapter: "Chapter 19", source: "ikiru" },
      { title: "Only I Have An EX-Grade Summon (Official)", chapter: "Chapter 19", source: "shinigami" },
    ],
  },
  {
    name: "Scenario 3: Judul Berbeda Karakter (Dash vs Space)",
    items: [
      { title: "Only I Have An EX-Grade Summon", chapter: "Chapter 20", source: "ikiru" },
      { title: "Only I Have An EX Grade Summon", chapter: "Chapter 20", source: "shinigami" },
    ],
  },
];

scenarios.forEach(scenario => {
  console.log(`[${scenario.name}]`);

  const keys = scenario.items.map(item => {
    // 1. Simulasikan pencocokan di cronRuntime.js
    const match = matcher(item);
    if (match) {
      item.canonicalTitle = match.title; // Ambil judul asli dari whitelist
    }

    // 2. Buat kunci dedupe
    const key = buildCrossSourceChapterKey(item);
    console.log(` - Source: ${item.source.padEnd(10)} | Scraped: "${item.title}" -> Key: ${key}`);
    return key;
  });

  const isDuplicate = keys[0] === keys[1];
  console.log(` >>> HASIL: ${isDuplicate ? "✅ BERHASIL DEDUPE (Kunci Sama)" : "❌ GAGAL (Kunci Berbeda)"}\n`);
});
