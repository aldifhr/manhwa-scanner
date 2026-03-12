import { waitUntil } from "@vercel/functions";
import { editInteractionResponseWithComponents } from "../discord.js";
import { buildWhitelistListResponse } from "../services/whitelist.js";

export default function handleList(payload, options, res) {
  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        const page = Math.max(1, Number.parseInt(options?.[0]?.value, 10) || 1);
        const { content, components } = await buildWhitelistListResponse(page);
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
