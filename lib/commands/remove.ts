import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { sourceLabel } from "../domain.js";
import { ensureGuildAdminResponse, isOwner } from "../permissions.js";
import { clearWhitelist, removeWhitelistEntry } from "../services/whitelist.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { getLogger } from "../logger.js";
import { CommandOption } from "../types.js";

const logger = getLogger({ scope: "commands:remove" });

function mockWarning(): string {
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    return "\n\n⚠️ **Mode Mock Redis Aktif:** Bot tidak terhubung ke database. Silakan pasang `UPSTASH_REDIS_REST_URL` di Environment Variables.";
  }
  return "";
}

export default function handleRemove(payload: any, options: CommandOption[], res: any) {
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
        content: "❌ Menghapus seluruh whitelist hanya bisa dilakukan oleh owner bot.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  if (!input) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Silakan masukkan judul, nomor urut manga, atau ketik `all` untuk menghapus semua.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });

  waitUntil(
    (async () => {
      try {
        if (isClearAll) {
          const result = await clearWhitelist();
          await editInteractionResponse(
            payload,
            `✅ **Whitelist dikosongkan.**\nBerhasil menghapus **${result.count}** manga dari database.`,
          );
          return;
        }

        const result = await removeWhitelistEntry(input);

        if (result.status === "removed_source") {
          const sourceLabelStr = result.removedSource
            ? sourceLabel(result.removedSource.source)
            : "Sumber";
          const title = result.item?.title || "Manga";
          const message = result.removedEntirely
            ? `Berhasil menghapus sumber **${sourceLabelStr}** dan karena merupakan sumber terakhir, manga **"${title}"** juga dihapus dari whitelist!`
            : `Berhasil menghapus sumber **${sourceLabelStr}** dari manga **"${title}"**!`;

          await editInteractionResponse(
            payload,
            `${message}\nTotal Whitelist: **${result.items.length}** manga`,
          );
          return;
        }

        if (result.status === "ambiguous") {
          const matches = result.matches || [];
          const lines = matches.map(({ item, index }: any) => {
            const title = item?.title || "Tanpa Judul";
            const sources = (item?.sources || [])
              .map((s: any) => `[${sourceLabel(s.source)}]`)
              .join(" ");
            return `${index + 1}. ${title} ${sources}`;
          });
          await editInteractionResponse(
            payload,
            `Ditemukan lebih dari satu hasil untuk **"${input}"**:\n${lines.join("\n")}\n\nGunakan \`/remove <nomor>\` dari hasil di atas.`,
          );
          return;
        }

        if (result.status === "not_found") {
          const count = (result as any).totalCount ?? 0;
          await editInteractionResponse(
            payload,
            `Peringatan: "${input}" tidak ditemukan di whitelist! (Jumlah item di database: ${count})${mockWarning()}\nGunakan /list untuk melihat nomor urut manga.`,
          );
          return;
        }

        const title = result.item?.title || "Manga";
        await editInteractionResponse(
          payload,
          `Berhasil menghapus **"${title}"** dan semua sumbernya dari whitelist!\nTotal Whitelist: **${result.items.length}** manga`,
        );
      } catch (err: unknown) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[handleRemove] Error");
        try {
          await editInteractionResponse(
            payload,
            `Terjadi kesalahan: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch (editErr: unknown) {
          logger.warn({ err: editErr instanceof Error ? editErr.message : String(editErr) }, "[handleRemove] Failed to edit error response");
        }
      }
    })(),
  );
}
