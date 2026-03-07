import { waitUntil } from "@vercel/functions";
import { loadWhitelist } from "../redis.js";
import { editInteractionResponseWithComponents } from "../discord.js";

export default function handleList(payload, options, res) {
  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        const whitelist = await loadWhitelist();

        if (!whitelist.length) {
          await editInteractionResponseWithComponents(
            payload,
            "Whitelist empty.",
            [],
            [],
          );
          return;
        }

        const pageSize = 10;
        const page = Math.max(1, parseInt(options?.[0]?.value, 10) || 1);
        const totalPage = Math.ceil(whitelist.length / pageSize);
        const safePage = Math.min(page, totalPage);
        const start = (safePage - 1) * pageSize;
        const slice = whitelist.slice(start, start + pageSize);

        const content =
          `Whitelist (${whitelist.length})\n` +
          `Page ${safePage}/${totalPage}\n\n` +
          slice
            .map(
              (item, i) =>
                `${start + i + 1}. [${item.source || "ikiru"}] ${item.title}`,
            )
            .join("\n");

        const components = [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Prev",
                custom_id: `list:${safePage - 1}`,
                disabled: safePage <= 1,
              },
              {
                type: 2,
                style: 2,
                label: `Page ${safePage}`,
                custom_id: "noop",
                disabled: true,
              },
              {
                type: 2,
                style: 1,
                label: "Next",
                custom_id: `list:${safePage + 1}`,
                disabled: safePage >= totalPage,
              },
            ],
          },
        ];

        await editInteractionResponseWithComponents(payload, content, components, []);
      } catch (err) {
        console.error("[handleList] Error:", err);
        await editInteractionResponseWithComponents(
          payload,
          `Error: ${err.message}`,
          [],
          [],
        );
      }
    })(),
  );
}
