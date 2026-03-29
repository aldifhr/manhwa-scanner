import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { sourceLabel } from "../domain/source.js";
import { ensureGuildAdminResponse } from "../permissions.js";
import { removeWhitelistEntry } from "../services/whitelist.js";

export default function handleRemove(payload, options, res) {
  const denied = ensureGuildAdminResponse(payload);
  if (denied) {
    return res.json(denied);
  }

  const input = String(options?.[0]?.value || "").trim();
  if (!input) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Silakan masukkan judul atau nomor urut manga yang ingin dihapus!",
        flags: 64,
      },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil((async () => {
    try {
      const result = await removeWhitelistEntry(input);
      if (result.status === "ambiguous") {
        const lines = result.matches.map(
          ({ item, index }) => {
            const sources = (item.sources || []).map(s => `[${sourceLabel(s.source)}]`).join(" ");
            return `${index + 1}. ${item.title} ${sources}`;
          },
        );
        await editInteractionResponse(
          payload,
          `Ditemukan lebih dari satu hasil untuk **"${input}"**:\n${lines.join("\n")}\n\nGunakan \`/remove <nomor>\` dari hasil di atas.`,
        );
        return;
      }

      if (result.status === "not_found") {
        await editInteractionResponse(
          payload,
          `Peringatan: **"${input}"** tidak ditemukan di whitelist!\nGunakan \`/list\` untuk melihat nomor urut manga.`,
        );
        return;
      }

      await editInteractionResponse(
        payload,
        `Berhasil menghapus **"${result.item.title}"** dan semua sumbernya dari whitelist!\nTotal Whitelist: **${result.items.length}** manga`,
      );
    } catch (err) {
      console.error("[handleRemove] Error:", err);
      await editInteractionResponse(payload, `Terjadi kesalahan: ${err.message}`);
    }
  })());
}
