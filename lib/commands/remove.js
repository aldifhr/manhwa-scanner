import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { sourceLabel } from "../domain.js";
import { ensureGuildAdminResponse, isOwner } from "../permissions.js";
import { clearWhitelist, removeWhitelistEntry } from "../services/whitelist.js";

export default function handleRemove(payload, options, res) {
  const denied = ensureGuildAdminResponse(payload);
  if (denied) {
    return res.json(denied);
  }

  const input = String(
    options?.find((o) => o.name === "input" || o.name === "query")?.value || "",
  ).trim();
  const isClearAll = input.toLowerCase() === "all";

  if (isClearAll && !isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content:
          "❌ Menghapus seluruh whitelist hanya bisa dilakukan oleh owner bot.",
        flags: 64,
      },
    });
  }

  if (!input) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content:
          "Silakan masukkan judul, nomor urut manga, atau ketik `all` untuk menghapus semua.",
        flags: 64,
      },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        if (isClearAll) {
          const result = await clearWhitelist();
          try {
            return await editInteractionResponse(
              payload,
              `✅ **Whitelist dikosongkan.**\nBerhasil menghapus **${result.count}** manga dari database.`,
            );
          } catch (editErr) {
            console.warn(
              `[handleRemove] Failed to edit response: ${editErr.message}`,
            );
            return;
          }
        }

        const result = await removeWhitelistEntry(input);

        if (result.status === "removed_source") {
          const sourceLabelStr = result.removedSource
            ? sourceLabel(result.removedSource.source)
            : "Sumber";
          const message = result.removedEntirely
            ? `Berhasil menghapus sumber **${sourceLabelStr}** dan karena merupakan sumber terakhir, manga **"${result.item.title}"** juga dihapus dari whitelist!`
            : `Berhasil menghapus sumber **${sourceLabelStr}** dari manga **"${result.item.title}"**!`;

          try {
            await editInteractionResponse(
              payload,
              `${message}\nTotal Whitelist: **${result.items.length}** manga`,
            );
          } catch (editErr) {
            console.warn(
              `[handleRemove] Failed to edit response: ${editErr.message}`,
            );
          }
          return;
        }

        if (result.status === "ambiguous") {
          const lines = result.matches.map(({ item, index }) => {
            const sources = (item.sources || [])
              .map((s) => `[${sourceLabel(s.source)}]`)
              .join(" ");
            return `${index + 1}. ${item.title} ${sources}`;
          });
          try {
            await editInteractionResponse(
              payload,
              `Ditemukan lebih dari satu hasil untuk **"${input}"**:\n${lines.join("\n")}\n\nGunakan \`/remove <nomor>\` dari hasil di atas.`,
            );
          } catch (editErr) {
            console.warn(
              `[handleRemove] Failed to edit response: ${editErr.message}`,
            );
          }
          return;
        }

        if (result.status === "not_found") {
          try {
            await editInteractionResponse(
              payload,
              `Peringatan: **"${input}"** tidak ditemukan di whitelist!\nGunakan \`/list\` untuk melihat nomor urut manga.`,
            );
          } catch (editErr) {
            console.warn(
              `[handleRemove] Failed to edit response: ${editErr.message}`,
            );
          }
          return;
        }

        try {
          await editInteractionResponse(
            payload,
            `Berhasil menghapus **"${result.item.title}"** dan semua sumbernya dari whitelist!\nTotal Whitelist: **${result.items.length}** manga`,
          );
        } catch (editErr) {
          console.warn(
            `[handleRemove] Failed to edit response: ${editErr.message}`,
          );
        }
      } catch (err) {
        console.error("[handleRemove] Error:", err);
        try {
          await editInteractionResponse(
            payload,
            `Terjadi kesalahan: ${err.message}`,
          );
        } catch (editErr) {
          console.warn(
            `[handleRemove] Failed to edit error response: ${editErr.message}`,
          );
        }
      }
    })(),
  );
}
