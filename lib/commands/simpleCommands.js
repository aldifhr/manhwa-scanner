import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { redis, setNotificationChannel } from "../redis.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { ensureGuildAdminResponse, isGuildAdmin } from "../permissions.js";
import { sourceLabel, MARK_REASON_LABELS } from "../domain.js";
import {
  markWhitelistEntry,
  buildWhitelistListResponse,
} from "../services/whitelist.js";
import {
  NOTIFY_MODES,
  getUserNotifyMode,
  setUserNotifyMode,
} from "../services/notifications.js";
import { performFullHealthCheck } from "../services/health.js";
import { fetchDiscordChannel } from "../services/channelValidation.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:simple" });

// ============ /list ============
export async function handleList(payload, options, res) {
  const page = Number(options?.find((o) => o.name === "page")?.value || 1);
  const search = options?.find((o) => o.name === "search")?.value || null;
  const filter = options?.find((o) => o.name === "filter")?.value || null;

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64 },
  });

  waitUntil(
    (async () => {
      try {
        const { content, components } = await buildWhitelistListResponse(
          page,
          10,
          { search, filter },
        );
        await editInteractionResponseWithComponents(payload, content, components);
      } catch (err) {
        logger.error({ err: err.message }, "[handleList] Error");
        await editInteractionResponse(
          payload,
          `❌ Gagal memuat daftar: ${err.message}`,
        );
      }
    })(),
  );
}

// ============ /mark ============
export function handleMark(payload, options, res) {
  const denied = ensureGuildAdminResponse(payload);
  if (denied) return res.json(denied);

  const query = String(
    options?.find((item) => item.name === "query")?.value || "",
  ).trim();
  const reason = String(
    options?.find((item) => item.name === "reason")?.value || "",
  ).trim();

  if (!query || !reason) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Silakan masukkan judul/nomor manga dan alasan mark.",
        flags: 64,
      },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const result = await markWhitelistEntry(query, reason);

        if (result.status === "ambiguous") {
          const lines = result.matches.map(
            ({ item, index }) =>
              `${index + 1}. [${sourceLabel(item.source)}] ${item.title}`,
          );
          await editInteractionResponse(
            payload,
            `Ditemukan lebih dari satu hasil untuk **"${query}"**:\n${lines.join("\n")}\n\nGunakan \`/mark <nomor>\` dari hasil di atas.`,
          );
          return;
        }

        if (result.status === "not_found") {
          await editInteractionResponse(
            payload,
            `Mark gagal. **"${query}"** tidak ditemukan.\nGunakan \`/list\` untuk melihat nomor urut manga.`,
          );
          return;
        }

        const label = result.reason ? MARK_REASON_LABELS[result.reason] : "None";
        await editInteractionResponse(
          payload,
          `Berhasil memperbarui status untuk **${result.item.title}** -> **${label}**`,
        );
      } catch (err) {
        logger.error({ err: err.message }, "[handleMark] Error");
        await editInteractionResponse(
          payload,
          `Terjadi kesalahan: ${err.message}`,
        );
      }
    })(),
  );
}

// ============ /pref ============
export async function handlePref(payload, options, res) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  if (subcommand === "ping") {
    const newMode = subOptions.find((o) => o.name === "mode")?.value;

    if (!newMode) {
      const currentMode = await getUserNotifyMode(userId);
      let desc = "";
      if (currentMode === NOTIFY_MODES.ALL) {
        desc =
          "🔔 **Semua Update**: Kamu akan di-tag untuk setiap update manga di whitelist.";
      } else if (currentMode === NOTIFY_MODES.FOLLOWS) {
        desc =
          "🔖 **Hanya Bookmark**: Kamu hanya akan di-tag untuk manga yang kamu bookmark.";
      } else {
        desc = "🔕 **Mati**: Kamu tidak akan di-tag sama sekali.";
      }

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `Mode notifikasi kamu saat ini: **${currentMode.toUpperCase()}**\n\n${desc}`,
          flags: 64,
        },
      });
    }

    try {
      await setUserNotifyMode(userId, newMode);

      let msg = "";
      if (newMode === NOTIFY_MODES.ALL) {
        msg = "✅ Mode Berhasil diubah: **SEMUA UPDATE**. Sekarang kamu akan di-tag untuk setiap update manga!";
      } else if (newMode === NOTIFY_MODES.FOLLOWS) {
        msg = "✅ Mode Berhasil diubah: **HANYA BOOKMARK**. Kamu hanya akan di-tag untuk manga yang kamu bookmark.";
      } else {
        msg = "✅ Mode Berhasil diubah: **NONAKTIF**. Kamu tidak akan mendapatkan tag notifikasi lagi.";
      }

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: msg, flags: 64 },
      });
    } catch (err) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `❌ Gagal mengubah preference: ${err.message}`,
          flags: 64,
        },
      });
    }
  }

  return res.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Subcommand tidak dikenal.", flags: 64 },
  });
}

// ============ /health ============
export async function handleHealth(payload, options, res) {
  if (!isGuildAdmin(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Command ini hanya untuk admin server.", flags: 64 },
    });
  }

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64 },
  });

  waitUntil(
    (async () => {
      try {
        await editInteractionResponse(
          payload,
          "🔍 **Sedang menjalankan Audit Kesehatan penuh...**\n_(Proses ini memakan waktu sekitar 30-60 detik)_",
        );

        const brokenLinks = await performFullHealthCheck();
        const lastCheck = await redis.get("health:last-check");
        const recommendations =
          (await redis.get("health:recommendations")) || [];

        const statusEmoji = brokenLinks.length === 0 ? "✅" : "⚠️";
        const content = [
          `## ${statusEmoji} Hasil Audit Kesehatan Bot`,
          `Audit selesai pada: \`${new Date(lastCheck).toLocaleString("id-ID")}\``,
          "",
          `Link dicek: **${brokenLinks.length + ((await redis.hlen("whitelist:data")) || 0)}** sumber`,
          `Link rusak ditemukan: **${brokenLinks.length}**`,
          "",
        ];

        if (brokenLinks.length > 0) {
          content.push("### ❌ Daftar Link Rusak:");
          const list = brokenLinks
            .slice(0, 10)
            .map((b) => `• **${b.title}** (${b.status})`)
            .join("\n");
          content.push(list);
          if (brokenLinks.length > 10)
            content.push(`_...dan ${brokenLinks.length - 10} lainnya._`);
        } else {
          content.push("✅ Semua link saat ini dapat diakses dengan baik.");
        }

        if (recommendations.length > 0) {
          content.push("");
          content.push(
            `💡 **Rekomendasi**: Ada **${recommendations.length}** manga dengan kegagalan berturut-turut. Pertimbangkan untuk menghapusnya.`,
          );
        }

        await editInteractionResponse(payload, content.join("\n"));
      } catch (err) {
        logger.error({ err: err.message }, "[handleHealth] Error");
        await editInteractionResponse(
          payload,
          `❌ Gagal menjalankan audit: ${err.message}`,
        );
      }
    })(),
  );
}

// ============ /setchannel ============
export function handleSetchannel(payload, options, res) {
  const denied = ensureGuildAdminResponse(payload);
  if (denied) return res.json(denied);

  const guildId = payload.guild_id;
  const channelId = payload.channel_id;

  if (!guildId || !channelId) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "❌ Tidak dapat mengidentifikasi channel.",
        flags: 64,
      },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const channel = await fetchDiscordChannel({
          channelId,
          botToken: process.env.DISCORD_BOT_TOKEN,
        });
        if (!channel) {
          await editInteractionResponse(
            payload.token,
            "❌ Channel tidak ditemukan.",
          );
          return;
        }
        if (String(channel.guild_id || "") !== String(guildId)) {
          await editInteractionResponse(
            payload.token,
            "❌ Channel harus berasal dari server yang sama.",
          );
          return;
        }

        await setNotificationChannel(guildId, channelId);
        await editInteractionResponse(
          payload.token,
          `✅ Channel notifikasi manhwa berhasil diset ke <#${channelId}>`,
        );
      } catch (err) {
        await editInteractionResponse(
          payload.token,
          `❌ Terjadi kesalahan: ${err.message}`,
        );
      }
    })(),
  );
}
