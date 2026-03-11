import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import {
  MARK_REASON_LABELS,
  markWhitelistEntry,
} from "../services/whitelist.js";

export default function handleMark(payload, options, res) {
  const query = String(options?.find((item) => item.name === "query")?.value || "").trim();
  const reason = String(options?.find((item) => item.name === "reason")?.value || "").trim();

  if (!query || !reason) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Please provide manga title/number and reason.", flags: 64 },
    });
  }

  res.json({ type: 5 });

  waitUntil(
    (async () => {
      try {
        const result = await markWhitelistEntry(query, reason);

        if (result.status === "not_found") {
          await editInteractionResponse(
            payload,
            `Mark gagal. **"${query}"** tidak ditemukan.\nGunakan \`/list\` untuk lihat nomor urut manga.`,
          );
          return;
        }

        const label = result.reason ? MARK_REASON_LABELS[result.reason] : "None";
        await editInteractionResponse(
          payload,
          `Updated mark untuk **${result.item.title}** -> **${label}**`,
        );
      } catch (err) {
        console.error("[handleMark] Error:", err);
        await editInteractionResponse(payload, `Error: ${err.message}`);
      }
    })(),
  );
}
