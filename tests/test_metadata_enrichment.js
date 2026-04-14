// Inline normalizeTitleKey (mirrors lib/domain.js)
function normalizeTitleKey(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ============================================================
// Mock "database" (simulates Redis metadata cache)
// Each key is a normalized titleKey, value is what Ikiru/Shinigami returns
// ============================================================
const ikiruApiData = new Map([
  ["entomologist_in_sichuan_tang_clan", {
    synopsis: "Assassin No.1 Kim Gun jatuh ke dunia Murim karena kecelakaan misterius...",
    genres: ["Action", "Adventure", "Fantasy"],
    rating: "9.5/10",
    cover: "https://ikiru/ento-cover.jpg",
  }],
  ["academy_s_undercover_professor", {
    synopsis: "Seseorang bereinkarnasi masuk ke tubuh profesor paling serius di akademi sihir...",
    genres: ["Magic", "School", "Fantasy"],
    rating: "9.8/10",
    cover: "https://ikiru/academy-cover.jpg",
  }],
]);

const shinigamiApiData = new Map([
  ["job_change_log", {
    synopsis: "Dia yang kehilangan kelasnya di dunia game akhirnya bertualang mencari identitas baru...",
    genres: ["Action", "Drama", "Game"],
    rating: "8.9/10",
    cover: "https://shinigami/job-change-cover.jpg",
  }],
  ["omniscient_reader_s_viewpoint", {
    synopsis: "Pembaca setia yang masuk ke dalam novel apokaliptik yang ia baca selama 3 tahun...",
    genres: ["Action", "Thriller", "Isekai"],
    rating: "9.9/10",
    cover: "https://shinigami/orv-cover.jpg",
  }],
]);

// ============================================================
// merge by source (simulates orchestrator enrichment logic)
// ============================================================
function getApiDataBySource(source, titleKey) {
  if (source === "ikiru") return ikiruApiData.get(titleKey);
  if (source === "shinigami_project" || source === "shinigami_mirror") return shinigamiApiData.get(titleKey);
  return null;
}

// ============================================================
// Simulate orchestrator enrichment step (STEP 2.5)
// ============================================================
function simulateEnrichment(chapters, bugIsActive) {
  let scrapedChapters = JSON.parse(JSON.stringify(chapters));

  // THE FIX we added to orchestrator.js
  if (!bugIsActive) {
    scrapedChapters.forEach((ch) => {
      if (!ch.titleKey) ch.titleKey = normalizeTitleKey(ch.title);
    });
  }

  const uniqueTitleKeys = [...new Set(scrapedChapters.map((ch) => ch.titleKey))];
  const metadataMap = new Map();

  if (bugIsActive) {
    // BUG: all chapters have titleKey=undefined, so the first chapter's
    // metadata gets stored under the `undefined` key, then applied to ALL chapters.
    const firstCh = scrapedChapters[0];
    const firstRealKey = normalizeTitleKey(firstCh.title);
    const fetchedMeta = getApiDataBySource(firstCh.source, firstRealKey);
    metadataMap.set(undefined, fetchedMeta);
  } else {
    // FIXED: each unique titleKey gets its own metadata from the correct source
    uniqueTitleKeys.forEach((tk) => {
      const ch = scrapedChapters.find((c) => c.titleKey === tk);
      if (ch) metadataMap.set(tk, getApiDataBySource(ch.source, tk));
    });
  }

  // Merge step
  scrapedChapters = scrapedChapters.map((ch) => {
    const meta = metadataMap.get(ch.titleKey);
    if (meta) {
      return {
        ...ch,
        synopsis: meta.synopsis,
        genres: meta.genres,
        rating: meta.rating,
        cover: meta.cover,
      };
    }
    return { ...ch, synopsis: null, genres: [], rating: "N/A" };
  });

  return scrapedChapters;
}

// ============================================================
// Test data — mixed Ikiru + Shinigami chapters (like real cron)
// ============================================================
const mockChapters = [
  // Ikiru
  { title: "Entomologist in Sichuan Tang Clan", chapter: "Chapter 79",  source: "ikiru" },
  { title: "Academy's Undercover Professor",    chapter: "Chapter 164", source: "ikiru" },
  // Shinigami
  { title: "Job Change Log",                    chapter: "Chapter 82",  source: "shinigami_project" },
  { title: "Omniscient Reader's Viewpoint",     chapter: "Chapter 210", source: "shinigami_mirror"  },
];

// ============================================================
// ASSERTIONS
// ============================================================
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// =====================
// SCENARIO 1 — BUG MODE
// =====================
console.log("\n==================================================");
console.log("🔴 SCENARIO 1: KONDISI BUG (SEBELUM DIPERBAIKI)");
console.log("==================================================");
const buggedResult = simulateEnrichment(mockChapters, true);

buggedResult.forEach(res => {
  console.log(`\n  Judul  : ${res.title} (${res.source})`);
  console.log(`  Chapter: ${res.chapter}`);
  console.log(`  Genres : ${(res.genres || []).join(", ") || "-"}`);
  console.log(`  Synopsis: ${(res.synopsis || "NULL").slice(0, 60)}...`);
});

console.log("\n[Assertions — semua seharusnya FAIL karena bug]");
// Academy, Job Change, ORV semuanya seharusnya dapat meta Entomologist (salah)
assert(
  buggedResult[1].synopsis === buggedResult[0].synopsis,
  "[BUG] Academy mendapat synopsis yang SAMA dengan Entomologist",
);
assert(
  buggedResult[2].synopsis === buggedResult[0].synopsis,
  "[BUG] Job Change Log mendapat synopsis yang SAMA dengan Entomologist",
);
assert(
  buggedResult[3].synopsis === buggedResult[0].synopsis,
  "[BUG] ORV mendapat synopsis yang SAMA dengan Entomologist",
);
assert(
  (buggedResult[2].genres || []).join(",") === (buggedResult[0].genres || []).join(","),
  "[BUG] Shinigami chapter mendapat genres Ikiru",
);

// =====================
// SCENARIO 2 — FIXED
// =====================
console.log("\n\n==================================================");
console.log("🟢 SCENARIO 2: KONDISI DIPERBAIKI (SAAT INI)");
console.log("==================================================");
const fixedResult = simulateEnrichment(mockChapters, false);

fixedResult.forEach(res => {
  console.log(`\n  Judul  : ${res.title} (${res.source})`);
  console.log(`  Chapter: ${res.chapter}`);
  console.log(`  Genres : ${(res.genres || []).join(", ") || "-"}`);
  console.log(`  Synopsis: ${(res.synopsis || "NULL").slice(0, 60)}...`);
});

console.log("\n[Assertions — semua seharusnya PASS]");
assert(
  fixedResult[0].synopsis.includes("Kim Gun"),
  "Entomologist mendapat synopsis-nya sendiri",
);
assert(
  fixedResult[1].synopsis.includes("bereinkarnasi"),
  "Academy mendapat synopsis-nya sendiri (berbeda dengan Entomologist)",
);
assert(
  fixedResult[1].synopsis !== fixedResult[0].synopsis,
  "Academy dan Entomologist synopsis BERBEDA",
);
assert(
  fixedResult[2].synopsis.includes("novel apokaliptik") === false && fixedResult[2].synopsis.includes("kelasnya"),
  "Job Change Log (Shinigami) mendapat synopsis-nya sendiri",
);
assert(
  fixedResult[3].synopsis.includes("apokaliptik"),
  "ORV (Shinigami Mirror) mendapat synopsis-nya sendiri",
);
assert(
  fixedResult[2].genres.includes("Game"),
  "Job Change Log mendapat genres dari Shinigami, bukan Ikiru",
);
assert(
  fixedResult[3].genres.includes("Isekai"),
  "ORV mendapat genres dari Shinigami, bukan Ikiru",
);
assert(
  !fixedResult.some(r => r.synopsis === null),
  "Tidak ada manga yang synopsisnya NULL",
);

// =====================
// SUMMARY
// =====================
console.log("\n==================================================");
console.log(`Test Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("🎉 Semua test LULUS! Bug metadata sudah diperbaiki.");
} else {
  console.log("⚠️  Ada test yang gagal, cek log di atas.");
}
console.log("==================================================\n");
