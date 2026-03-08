import "dotenv/config";
import { searchIkiru, searchShngm } from "./lib/scraper.js";

function getArg(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function normalizeSource(raw = "ikiru") {
  const source = String(raw).toLowerCase().trim();
  if (source === "mirror" || source === "shinigami_mirror") return "shinigami_mirror";
  if (source === "shinigami" || source === "project" || source === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function normalizeTitleKey(title = "") {
  return String(title)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMangaIdFromUrl(url = "") {
  const m = String(url).match(/\/series\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

async function fetchShinigamiChaptersByMangaId(mangaId, limit = 24) {
  if (!mangaId) return [];
  const base = (process.env.SECONDARY_SOURCE_URL || "https://api.shngm.io").replace(/\/+$/, "");
  const url =
    `${base}/v1/chapter/${mangaId}/list` +
    `?page=1&page_size=${limit}&sort_by=chapter_number&sort_order=desc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Shinigami chapter endpoint HTTP ${res.status}`);
  const payload = await res.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

function filterFresh24h(chapters = []) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return chapters.filter((row) => {
    const raw = row?.release_date || row?.created_at || row?.updated_at || "";
    const ts = Date.parse(raw);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

async function runTitleMode(title, source) {
  if (!title) throw new Error("title kosong. pakai --title \"judul\"");

  if (source === "ikiru") {
    const rows = await searchIkiru(title, {}, null);
    const key = normalizeTitleKey(title);
    const exact = rows.find((row) => normalizeTitleKey(row.title) === key);
    if (!exact) {
      console.log(`Tidak ketemu judul exact di Ikiru: "${title}"`);
      return;
    }

    console.log(`Title : ${exact.title}`);
    console.log(`Source: ikiru`);
    console.log(`URL   : ${exact.mangaUrl || exact.url || "-"}`);
    console.log(`Info  : Mode title untuk Ikiru menampilkan matching title (chapter list endpoint tidak tersedia).`);
    return;
  }

  const rows = await searchShngm(title, source);
  const key = normalizeTitleKey(title);
  const exact = rows.find((row) => normalizeTitleKey(row.title) === key) || rows[0];
  if (!exact) {
    console.log(`Tidak ketemu judul di ${source}: "${title}"`);
    return;
  }

  const mangaId = extractMangaIdFromUrl(exact.mangaUrl);
  if (!mangaId) throw new Error("gagal extract manga id dari hasil search");

  const chapterRows = await fetchShinigamiChaptersByMangaId(mangaId, 24);
  const fresh = filterFresh24h(chapterRows);

  console.log(`Title : ${exact.title}`);
  console.log(`Source: ${source}`);
  console.log(`URL   : ${exact.mangaUrl}`);
  console.log(`Fresh <24h: ${fresh.length}`);
  for (const row of fresh) {
    console.log(
      `- Chapter ${row.chapter_number} | ${row.release_date || row.created_at || "-"} | ` +
      `https://a.shinigami.asia/chapter/${row.chapter_id}`,
    );
  }
}

async function runQueryMode(query, source) {
  const keyword = String(query || "demon").trim();
  console.log(`Mode  : query`);
  console.log(`Source: ${source}`);
  console.log(`Query : ${keyword}`);

  if (source === "ikiru") {
    const rows = await searchIkiru(keyword, {}, null);
    console.log(`Results: ${rows.length}`);
    rows.slice(0, 10).forEach((row, i) => {
      console.log(`${String(i + 1).padStart(2, "0")}. ${row.title}`);
    });
    return;
  }

  const rows = await searchShngm(keyword, source);
  console.log(`Results: ${rows.length}`);
  rows.slice(0, 10).forEach((row, i) => {
    console.log(`${String(i + 1).padStart(2, "0")}. ${row.title}`);
  });
}

async function main() {
  const source = normalizeSource(getArg("--source", "ikiru"));
  const title = getArg("--title", "").trim();
  const query = getArg("--query", "demon").trim();

  if (title) {
    await runTitleMode(title, source);
    return;
  }

  await runQueryMode(query, source);
}

main().catch((err) => {
  console.error("test-local failed:", err.message);
  process.exit(1);
});
