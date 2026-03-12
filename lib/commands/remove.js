import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { removeWhitelistEntry } from "../services/whitelist.js";

export default function handleRemove(payload, options, res) {
  const input = String(options?.[0]?.value || "").trim();
  if (!input) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Please provide a manga title or number!" },
    });
  }

  res.json({ type: 5 });

  waitUntil((async () => {
    try {
      const result = await removeWhitelistEntry(input);
      if (result.status === "not_found") {
        await editInteractionResponse(
          payload,
          `Warning: **"${input}"** tidak ditemukan di whitelist!\nGunakan \`/list\` untuk lihat nomor urut manga.`,
        );
        return;
      }

      await editInteractionResponse(
        payload,
        `Removed **"${result.item.title}"** dari whitelist!\nTotal: **${result.items.length}** manga`,
      );
    } catch (err) {
      console.error("[handleRemove] Error:", err);
      await editInteractionResponse(payload, `Error: ${err.message}`);
    }
  })());
}
