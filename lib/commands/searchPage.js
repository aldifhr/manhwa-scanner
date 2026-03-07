import { editInteractionResponseWithComponents } from "../discord.js";
import { searchIkiru, searchShngm } from "../scraper.js";
import { buildSearchEmbed, buildSearchComponents } from "./search.js";

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "all") return "all";
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const item of results) {
    const key = `${item.source || "ikiru"}::${(item.mangaUrl || item.url || "").toLowerCase().replace(/\/+$/, "")}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function searchBySource(keyword, source, redis) {
  if (source === "all") {
    const [ikiru, project, mirror] = await Promise.all([
      searchIkiru(keyword, {}, redis),
      searchShngm(keyword, "shinigami_project"),
      searchShngm(keyword, "shinigami_mirror"),
    ]);
    return [
      ...ikiru.map((x) => ({ ...x, source: "ikiru" })),
      ...project,
      ...mirror,
    ];
  }

  if (source === "ikiru") {
    const rows = await searchIkiru(keyword, {}, redis);
    return rows.map((x) => ({ ...x, source: "ikiru" }));
  }

  return searchShngm(keyword, source);
}

export default async function handleSearchPage(
  payload,
  keyword,
  page,
  source = "all",
  redis = null,
) {
  try {
    const normalizedSource = normalizeSource(source);
    const results = dedupeResults(
      await searchBySource(keyword, normalizedSource, redis),
    );

    if (!results.length) {
      await editInteractionResponseWithComponents(
        payload,
        `No manga found for **${keyword}**.`,
        [],
      );
      return;
    }

    const perPage = 10;
    const total = results.length;
    const totalPage = Math.ceil(total / perPage);
    const safePage = Math.max(1, Math.min(page, totalPage));
    const slice = results.slice((safePage - 1) * perPage, safePage * perPage);

    const embed = buildSearchEmbed(
      keyword,
      normalizedSource,
      slice,
      safePage,
      totalPage,
      total,
    );
    const components = buildSearchComponents(
      keyword,
      normalizedSource,
      slice,
      safePage,
      totalPage,
    );

    await editInteractionResponseWithComponents(payload, "", components, [embed]);
  } catch (err) {
    await editInteractionResponseWithComponents(payload, `Error: ${err.message}`, []);
  }
}

