import { waitUntil }                        from "@vercel/functions";
import { loadWhitelist, saveWhitelist }     from "../redis.js";
import { editInteractionResponse }          from "../discord.js";
import { isOwner }                          from "../permissions.js";
import { InteractionResponseType }          from "discord-interactions";

export default function handleClear(payload, options, res) {
  if (!isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "❌ Command ini hanya untuk owner bot.",
        flags:   64,
      },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil((async () => {
    try {
      const whitelist = await loadWhitelist();
      const count     = whitelist.length;
      await saveWhitelist([]);
      await editInteractionResponse(payload,
        `🗑️ **Whitelist cleared!**\nRemoved **${count}** manga dari whitelist.`
      );
    } catch (err) {
      console.error("[handleClear] Error:", err);
      await editInteractionResponse(payload, `❌ Error: ${err.message}`);
    }
  })());
}
