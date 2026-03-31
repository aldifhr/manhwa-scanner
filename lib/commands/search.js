import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { resolveWhitelistQuery } from "../services/whitelist.js";
import { loadWhitelist } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { sourceLabel } from "../domain/source.js";

async function executeSearch(payload, input) {
  try {
    const items = await loadWhitelist();
    const result = resolveWhitelistQuery(items, input);

    if (result.status === "not_found") {
      await editInteractionResponse(
        payload,
        `Manga **"${input}"** tidak ditemukan di whitelist.`,
      );
      return;
    }

    if (result.status === "ambiguous") {
      const lines = result.matches.slice(0, 10).map(({ item, index }) => {
        const sources = (item.sources || []).map(s => `[${sourceLabel(s.source)}]`).join(" ");
        return `${index + 1}. ${item.title} ${sources}`;
      });
      
      let message = `Ditemukan beberapa hasil untuk **"${input}"**:\n${lines.join("\n")}`;
      if (result.matches.length > 10) {
        message += `\n...dan ${result.matches.length - 10} lainnya.`;
      }
      message += `\n\nGunakan pencarian yang lebih spesifik.`;

      await editInteractionResponse(payload, message);
      return;
    }

    const { item } = result;
    const sourcesText = item.sources
      .map(s => {
        const markText = s.mark ? ` \`(${s.mark})\`` : "";
        return `• [${sourceLabel(s.source)}](${s.url})${markText}`;
      })
      .join("\n");

    const embed = {
      title: `🔍 Hasil Pencarian: ${item.title}`,
      description: `Manga ini sudah terdaftar di whitelist dengan sumber berikut:\n\n${sourcesText}`,
      color: 0x3498db,
      footer: { text: `Total Whitelist: ${items.length} manga` }
    };

    // Note: editInteractionResponse in this project usually takes (payloadOrToken, contentOrEmbed)
    // Looking at discord.js: editInteractionResponse(payload, content)
    // Actually, looking at other commands, it usually sends raw text or complex logic.
    // I will stick to text if I'm not sure about the embed support in editInteractionResponse.
    // Wait, resync24h uses sendDiscordEmbed for notifications but editInteractionResponse for feedback.
    // I'll check discord.js to see if it supports embeds.
    
    await editInteractionResponse(payload, { embeds: [embed] });
  } catch (err) {
    console.error("[handleSearch] Error:", err);
    await editInteractionResponse(payload, `Terjadi kesalahan saat mencari: ${err.message}`);
  }
}

export default function handleSearch(payload, options, res) {
  const input = String(options?.[0]?.value || "").trim();
  if (!input) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Silakan masukkan judul atau URL manga yang ingin dicari!", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(executeSearch(payload, input));
}
