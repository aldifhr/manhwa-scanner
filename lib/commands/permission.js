import { InteractionResponseType } from "discord-interactions";
import { isGuildAdmin, isOwner } from "../permissions.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:permission" });

export default async function handlePermission(payload, options, res, redis) {
  // Only Admin or Owner can manage permissions
  if (!isGuildAdmin(payload) && !isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content:
          "❌ Command ini hanya bisa dijalankan oleh Admin server atau Owner bot.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  // Extract options from flat structure (not subcommand)
  const action = options?.find((o) => o.name === "action")?.value;
  const userOption = options?.find((o) => o.name === "user")?.value;

  if (action === "list") {
    const allowed = await redis.smembers("whitelist:allowed_users");
    if (!allowed || allowed.length === 0) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content:
            "📋 Daftar user yang diizinkan kosong (hanya default owner/admin).",
          flags: DISCORD_EPHEMERAL_FLAG,
        },
      });
    }

    const mentions = allowed.map((id) => `<@${id}>`).join(", ");
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `📋 **User yang Diizinkan /add:**\n${mentions}`,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  if (!userOption) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "❌ Pilih user yang ingin dikelola.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  try {
    if (action === "grant" || action === "add") {
      await redis.sadd("whitelist:allowed_users", userOption);
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Berhasil menambahkan <@${userOption}> ke daftar izin /add.`,
          flags: DISCORD_EPHEMERAL_FLAG,
        },
      });
    }

    if (action === "revoke" || action === "remove") {
      await redis.srem("whitelist:allowed_users", userOption);
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Berhasil menghapus <@${userOption}> dari daftar izin /add.`,
          flags: DISCORD_EPHEMERAL_FLAG,
        },
      });
    }

    // Unknown action - must return error response
    logger.warn({ action, userId: userOption }, "Unknown permission action");
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "❌ Tindakan tidak dikenal. Gunakan: `list`, `add`, atau `remove`.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  } catch (err) {
    logger.error({ err: err.message, action, userId: userOption }, "Permission action failed");
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `❌ Terjadi kesalahan: ${err.message}`,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }
}
