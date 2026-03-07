import { waitUntil } from "@vercel/functions";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { searchIkiru, searchShngm } from "../scraper.js";
import { InteractionResponseType } from "discord-interactions";

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "all") return "all";
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function sourceLabel(source) {
  if (source === "shinigami_project") return "Shinigami (Project)";
  if (source === "shinigami_mirror") return "Shinigami (Mirror)";
  if (source === "all") return "All Sources";
  return "Ikiru";
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

export default function handleSearch(payload, options, res, redis = null) {
  const keyword = options?.find((o) => o.name === "keyword")?.value;
  const source = normalizeSource(
    options?.find((o) => o.name === "source")?.value || "all",
  );

  if (!keyword) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Please provide a keyword." },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const raw = await searchBySource(keyword, source, redis);
        const results = dedupeResults(raw);

        if (!results.length) {
          await editInteractionResponse(
            payload,
            `No manga found for **${keyword}** in **${sourceLabel(source)}**.`,
          );
          return;
        }

        if (redis) {
          await redis
            .set(`search:results:${source}:${keyword}`, results, { ex: 300 })
            .catch(() => {});
        }

        const page = 1;
        const perPage = 10;
        const total = results.length;
        const totalPage = Math.ceil(total / perPage);
        const slice = results.slice(0, perPage);

        const embed = buildSearchEmbed(keyword, source, slice, page, totalPage, total);
        const components = buildSearchComponents(
          keyword,
          source,
          slice,
          page,
          totalPage,
        );

        await editInteractionResponseWithComponents(payload, "", components, [embed]);
      } catch (err) {
        await editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })(),
  );
}

export function buildSearchEmbed(keyword, source, slice, page, totalPage, total) {
  return {
    color: 0x5865f2,
    author: {
      name: `Search: "${keyword}" (${sourceLabel(source)})`,
      icon_url:
        "https://02.ikiru.wtf/wp-content/uploads/2025/06/logo-ikiru-264736-Qt7APF3i.png",
    },
    description: slice
      .map((item, i) => {
        const src = sourceLabel(item.source || "ikiru");
        const link = item.mangaUrl ?? item.url;
        return `**${(page - 1) * 10 + i + 1}.** [${item.title}](${link})\n\`${src}\``;
      })
      .join("\n\n"),
    thumbnail: slice[0]?.cover ? { url: slice[0].cover } : undefined,
    footer: {
      text: `${total} found  |  Page ${page}/${totalPage}`,
    },
    timestamp: new Date().toISOString(),
  };
}

export function buildSearchComponents(keyword, source, slice, page, totalPage) {
  const selectRow = {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: "select_add",
        placeholder: "Select manga to add...",
        options: slice.map((item, idx) => {
          const id = item.slug ?? item.mangaUrl ?? item.url ?? String(idx);
          const value = `${source}|||${keyword}|||${id}`;
          return {
            label:
              item.title.length > 100
                ? `${item.title.substring(0, 97)}...`
                : item.title,
            value: value.substring(0, 100),
            description: sourceLabel(item.source || "ikiru").substring(0, 100),
          };
        }),
      },
    ],
  };

  const encodedKeyword = encodeURIComponent(keyword);
  const navRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: "Prev",
        custom_id: `search:${source}:${encodedKeyword}:${page - 1}`,
        disabled: page <= 1,
      },
      {
        type: 2,
        style: 2,
        label: `${page} / ${totalPage}`,
        custom_id: "noop_nav",
        disabled: true,
      },
      {
        type: 2,
        style: 2,
        label: "Next",
        custom_id: `search:${source}:${encodedKeyword}:${page + 1}`,
        disabled: page >= totalPage,
      },
    ],
  };

  return [selectRow, navRow];
}

