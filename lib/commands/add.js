import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { searchIkiru, searchShngm } from "../scraper.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";

function normalizeSource(source) {
  const s = String(source || "").toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function sourceLabel(source) {
  if (source === "shinigami_project") return "Shinigami (Project)";
  if (source === "shinigami_mirror") return "Shinigami (Mirror)";
  return "Ikiru";
}

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

function createAddSessionId(source) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${source}:${stamp}:${rand}`;
}

async function searchAddResults(query, source, redis = null) {
  if (source === "ikiru") {
    return {
      results: await searchIkiru(query, {}, redis),
      sourceUsed: "ikiru",
      usedFallback: false,
    };
  }

  const primary = await searchShngm(query, "shinigami_project");
  if (primary.length) {
    return {
      results: primary,
      sourceUsed: "shinigami_project",
      usedFallback: false,
    };
  }

  const fallback = await searchShngm(query, "shinigami_mirror");
  return {
    results: fallback,
    sourceUsed: "shinigami_mirror",
    usedFallback: true,
  };
}

export default function handleAdd(payload, options, res, redis = null) {
  const source = normalizeSource(getOption(options, "source") || "ikiru");
  const query = String(getOption(options, "title") || "").trim();

  if (!query) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Please provide manga title.", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const { results, sourceUsed, usedFallback } = await searchAddResults(
          query,
          source,
          redis,
        );

        if (!results.length) {
          await editInteractionResponse(
            payload,
            source === "ikiru"
              ? `No result for **${query}** in **${sourceLabel(source)}**.`
              : `No result for **${query}** in **Shinigami (Project/Mirror)**.`,
          );
          return;
        }

        const top = results.slice(0, 10);
        const sessionId = createAddSessionId(sourceUsed);
        const cacheKey = `add:results:${sessionId}`;
        if (redis) {
          await redis.set(cacheKey, top, { ex: 300 }).catch(() => {});
        }

        const optionsSelect = top.map((item, i) => {
          return {
            label:
              item.title.length > 100
                ? `${item.title.substring(0, 97)}...`
                : item.title,
            value: `${sessionId}|||${i}`,
            description: (item.chapter || "Select to add").substring(0, 100),
          };
        });

        const components = [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: "select_add_src",
                placeholder: `Select manga from ${sourceLabel(sourceUsed)}...`,
                options: optionsSelect,
              },
            ],
          },
        ];

        await editInteractionResponseWithComponents(
          payload,
          usedFallback
            ? `No result in **Shinigami (Project)**. Showing results from **Shinigami (Mirror)** for **${query}**.`
            : `Choose one result from **${sourceLabel(sourceUsed)}** for query **${query}**.`,
          components,
          [],
        );
      } catch (err) {
        await editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })(),
  );
}
