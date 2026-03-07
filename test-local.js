import "dotenv/config";
import {
  fetchLatestMangaUpdateTime,
  searchIkiru,
  searchShngm,
} from "./lib/scraper.js";

const MAX_STALE_MS = 1000 * 60 * 60 * 24 * 30 * 8; // ~8 months

function parseUpdatedTime(item) {
  const ts = item?.updatedTime ? new Date(item.updatedTime).getTime() : NaN;
  return Number.isNaN(ts) ? null : ts;
}

function sortByActivePriority(results = []) {
  const now = Date.now();
  const active = [];
  const unknown = [];
  const stale = [];

  for (const item of results) {
    const ts = parseUpdatedTime(item);
    if (ts === null) {
      unknown.push(item);
    } else if (now - ts > MAX_STALE_MS) {
      stale.push(item);
    } else {
      active.push(item);
    }
  }

  return [...active, ...unknown, ...stale];
}

const IKIRU_ENRICH_LIMIT = 24;
const IKIRU_ENRICH_CONCURRENCY = 4;

async function enrichIkiruUpdatedTimes(results = []) {
  const out = results.map((item) => ({ ...item }));
  const limit = Math.min(out.length, IKIRU_ENRICH_LIMIT);
  let nextIndex = 0;

  const workers = Array.from({ length: IKIRU_ENRICH_CONCURRENCY }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= limit) break;

      const item = out[i];
      const mangaUrl = item.mangaUrl || item.url;
      if (!mangaUrl) continue;

      const updatedTime = await fetchLatestMangaUpdateTime(mangaUrl, null);
      if (updatedTime) item.updatedTime = updatedTime;
    }
  });

  await Promise.all(workers);
  return out;
}

function sourceLabel(source) {
  if (source === "shinigami_project") return "Shinigami (Project)";
  if (source === "shinigami_mirror") return "Shinigami (Mirror)";
  return "Ikiru";
}

function classify(item) {
  const ts = parseUpdatedTime(item);
  if (ts === null) return "unknown";
  return Date.now() - ts > MAX_STALE_MS ? "stale" : "active";
}

async function main() {
  const sourceArg = String(process.argv[2] || "ikiru").toLowerCase().trim();
  const query = String(process.argv[3] || "demon").trim();

  let source = "ikiru";
  if (sourceArg === "shinigami" || sourceArg === "project") {
    source = "shinigami_project";
  } else if (sourceArg === "mirror" || sourceArg === "shinigami_mirror") {
    source = "shinigami_mirror";
  }

  console.log(`Live test /add ordering`);
  console.log(`Source: ${sourceLabel(source)} | Query: "${query}"\n`);

  let results = [];
  if (source === "ikiru") {
    const raw = (await searchIkiru(query, {}, null)).map((item) => ({
      ...item,
      updatedTime: null,
    }));
    results = await enrichIkiruUpdatedTimes(raw);
  } else {
    results = await searchShngm(query, source);
  }

  if (!results.length) {
    console.log("No results from source.");
    process.exit(0);
  }

  const sorted = sortByActivePriority(results);
  const maxPrint = Math.min(25, sorted.length);

  console.log(`Total results: ${sorted.length} (showing ${maxPrint})`);
  for (let i = 0; i < maxPrint; i++) {
    const item = sorted[i];
    const bucket = classify(item);
    console.log(
      `${String(i + 1).padStart(2, "0")}. [${bucket}] ${item.title} | ${item.updatedTime || "-"}`,
    );
  }
}

main().catch((err) => {
  console.error("test-local failed:", err.message);
  process.exit(1);
});
