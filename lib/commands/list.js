import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { buildWhitelistListResponse } from "../services/whitelist.js";
import { editInteractionResponseWithComponents, editInteractionResponse } from "../discord.js";

export default async function handleList(payload, options, res) {
  // Extract options if any (page, search, status)
  const page = Number(options?.find(o => o.name === "page")?.value || 1);
  const search = options?.find(o => o.name === "search")?.value || null;
  const filter = options?.find(o => o.name === "filter")?.value || null;

  // Akui perintah dengan pesan loading
  res.json({ 
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, 
    data: { flags: 64 } 
  });

  waitUntil((async () => {
    try {
      const { content, components } = await buildWhitelistListResponse(page, 10, { search, filter });
      await editInteractionResponseWithComponents(payload, content, components);
    } catch (err) {
      console.error("[handleList] Error:", err.message);
      await editInteractionResponse(payload, `❌ Gagal memuat daftar: ${err.message}`);
    }
  })());
}
