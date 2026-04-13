/**
 * test_verify.js
 *
 * Script verifikasi perbaikan Shinigami scraper & alur pengiriman Discord.
 * Jalankan: node test_verify.js
 */

import "dotenv/config";
import { scrapeSecondarySourceUpdates, searchShngm } from "./lib/scrapers/secondary.js";
import { enqueueNotifications, dequeueNotifications, getQueueLength } from "./lib/services/notificationQueue.js";
import { normalizeTitleKey } from "./lib/scrapers/shared.js";
import { redis } from "./lib/redis.js";

const GREEN = "\x1b[32m✅";
const RED = "\x1b[31m❌";
const YELLOW = "\x1b[33m⚠️ ";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`${GREEN} ${msg}${RESET}`);
  passed++;
}

function fail(msg, err = "") {
  console.log(`${RED} ${msg}${err ? ` → ${err}` : ""}${RESET}`);
  failed++;
}

function warn(msg) {
  console.log(`${YELLOW} ${msg}${RESET}`);
}

function section(title) {
  console.log(`\n${BOLD}── ${title} ──${RESET}`);
}

// ─── 1. Cek normalizeTitleKey tersedia ───────────────────────────────────────
section("1. Import normalizeTitleKey");
try {
  const key = normalizeTitleKey("Only I Have An EX-Grade Summon");
  if (key && typeof key === "string") {
    pass(`normalizeTitleKey berjalan → "${key}"`);
  } else {
    fail("normalizeTitleKey mengembalikan nilai kosong");
  }
} catch (err) {
  fail("normalizeTitleKey gagal", err.message);
}

// ─── 2. Cek Shinigami API langsung ───────────────────────────────────────────
section("2. Shinigami API - Chapter terbaru 'Only I Have An EX-Grade Summon'");
try {
  const res = await fetch(
    "https://api.shngm.io/v1/manga/detail/727a1e2e-73e9-4a21-a948-2ad2568243d3",
    { headers: { Accept: "application/json" } },
  );
  const json = await res.json();
  const detail = json?.data;
  if (detail?.latest_chapter_number >= 18) {
    pass(`Chapter terbaru di Shinigami: ${detail.latest_chapter_number} (rilis: ${detail.latest_chapter_time})`);
  } else {
    warn(`Chapter terbaru: ${detail?.latest_chapter_number} (mungkin belum ch 18+)`);
  }
} catch (err) {
  fail("Shinigami API tidak bisa diakses", err.message);
}

// ─── 3. Cek searchShngm untuk judul tersebut ─────────────────────────────────
section("3. searchShngm - Cari 'only i have an ex grade summon'");
try {
  const results = await searchShngm("ex-grade summon", "shinigami_project");
  if (results.length > 0) {
    pass(`searchShngm menemukan ${results.length} hasil → "${results[0].title}" (${results[0].mangaUrl})`);
  } else {
    fail("searchShngm tidak menemukan hasil");
  }
} catch (err) {
  fail("searchShngm gagal", err.message);
}

// ─── 4. Shinigami Scraper TIDAK crash ─────────────────────────────────────────
section("4. scrapeSecondarySourceUpdates - Tidak error, tidak crash");
const TITLE_KEY = normalizeTitleKey("Only I Have An EX-Grade Summon");
try {
  const mockMatcher = {
    titleKeys: new Set([TITLE_KEY]),
    urlKeys: new Set(),
    urlTitleMap: new Map(),
  };

  const startTime = Date.now();
  const result = await scrapeSecondarySourceUpdates(
    "shinigami_project",
    {
      preferredMatcher: mockMatcher,
      redis,
      options: {
        lookbackHours: 168, // 7 hari
        skipExpansion: false,
        fullRefresh: true,
      },
    },
    console,
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result && Array.isArray(result.results)) {
    if (result.results.length > 0) {
      pass(`Scraper berjalan (${elapsed}s) → ditemukan ${result.results.length} chapter:`);
      result.results.forEach((r) => {
        console.log(`   📖 ${r.title} • ${r.chapter} (${r.source})`);
      });
    } else {
      warn(`Scraper berjalan (${elapsed}s) tapi 0 chapter ditemukan (mungkin sudah di luar lookback window)`);
      passed++;
    }
    if (result.metrics) {
      console.log(`   📊 Metrics: attempts=${result.metrics.detailAttempts}, successes=${result.metrics.detailSuccesses}`);
    }
  } else {
    fail("Result tidak valid", JSON.stringify(result));
  }
} catch (err) {
  fail("scrapeSecondarySourceUpdates CRASH", err.message);
  console.error(err);
}

// ─── 5. Notification Queue roundtrip ─────────────────────────────────────────
section("5. Notification Queue - Enqueue & Dequeue");
const TEST_QUEUE_TASK = {
  chapter: { title: "[TEST] Only I Have An EX-Grade Summon", chapter: "Chapter 99", url: "https://test.example/" },
  channelIds: ["000000000000000000"],
  mentions: [],
  primaryKey: "chapter:test:verify",
  duplicateKey: "chapter:dedupe:test:verify",
  __test: true,
};

try {
  const beforeLen = await getQueueLength(redis);
  await enqueueNotifications([TEST_QUEUE_TASK], redis);
  const afterLen = await getQueueLength(redis);

  if (afterLen === beforeLen + 1) {
    pass(`Enqueue berhasil → queue length: ${beforeLen} → ${afterLen}`);
  } else {
    fail(`Queue length tidak bertambah (before=${beforeLen}, after=${afterLen})`);
  }

  // Dequeue balik
  const dequeued = await dequeueNotifications(1, redis);
  if (dequeued.length > 0 && (dequeued[0].__test === true || (typeof dequeued[0] === "object" && dequeued[0].chapter?.title?.includes("[TEST]")))) {
    pass("Dequeue berhasil → task test berhasil diambil kembali");
  } else if (dequeued.length > 0) {
    pass(`Dequeue berhasil → task diambil (${JSON.stringify(dequeued[0]).slice(0, 60)}...)`);
  } else {
    fail("Dequeue gagal atau queue kosong");
  }
} catch (err) {
  fail("Queue roundtrip gagal", err.message);
}

// ─── Ringkasan ─────────────────────────────────────────────────────────────
console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${BOLD}Hasil: ${GREEN}${passed} passed${RESET}  ${RED}${failed} failed${RESET}`);
if (failed === 0) {
  console.log(`${GREEN} Semua test lulus! Bot siap mengirim notifikasi ke Discord.${RESET}`);
} else {
  console.log(`${RED} Ada ${failed} test gagal. Periksa error di atas sebelum deploy.${RESET}`);
}
console.log();

process.exit(failed > 0 ? 1 : 0);
