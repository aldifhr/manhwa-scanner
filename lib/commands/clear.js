import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { isOwner } from "../permissions.js";
import { clearWhitelist } from "../services/whitelist.js";

export default function handleClear(payload, options, res) {
  void options;
  if (!isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Command ini hanya untuk owner bot.",
        flags: 64,
      },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil((async () => {
    try {
      const result = await clearWhitelist();
      await editInteractionResponse(
        payload,
        `Whitelist cleared.\nRemoved **${result.count}** manga dari whitelist.`,
      );
    } catch (err) {
      console.error("[handleClear] Error:", err);
      await editInteractionResponse(payload, `Error: ${err.message}`);
    }
  })());
}
