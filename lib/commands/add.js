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
        const results =
          source === "ikiru"
            ? await searchIkiru(query, {}, redis)
            : await searchShngm(query, source);

        if (!results.length) {
          await editInteractionResponse(
            payload,
            `No result for **${query}** in **${sourceLabel(source)}**.`,
          );
          return;
        }

        const top = results.slice(0, 10);
        const cacheKey = `add:results:${source}:${query}`;
        if (redis) {
          await redis.set(cacheKey, top, { ex: 300 }).catch(() => {});
        }

        const optionsSelect = top.map((item, i) => {
          const id = item.slug ?? item.mangaUrl ?? item.url ?? String(i);
          return {
            label:
              item.title.length > 100
                ? `${item.title.substring(0, 97)}...`
                : item.title,
            value: `${source}|||${query}|||${id}`.substring(0, 100),
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
                placeholder: `Select manga from ${sourceLabel(source)}...`,
                options: optionsSelect,
              },
            ],
          },
        ];

        await editInteractionResponseWithComponents(
          payload,
          `Choose one result from **${sourceLabel(source)}** for query **${query}**.`,
          components,
          [],
        );
      } catch (err) {
        await editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })(),
  );
}

