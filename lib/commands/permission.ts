import { InteractionResponseType } from "discord-interactions";
import { isGuildAdmin, isOwner } from "../permissions.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { getLogger } from "../logger.js";
import { RedisClient, SubcommandOption } from "../types.js";

const logger = getLogger({ scope: "commands:permission" });

export default async function handlePermission(payload: any, options: SubcommandOption[], res: any, redis: RedisClient) {
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

  // Extract subcommand and its options
  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];
  
  const userOption = subOptions.find((o: any) => o.name === "user")?.value;
  const action = subcommand; // use subcommand name as action

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

    const mentions = allowed.map((id: string) => `<@${id}>`).join(", ");
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
  } catch (err: unknown) {
    logger.error({ err: (err as any).message, action, userId: userOption }, "Permission action failed");
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `❌ Terjadi kesalahan: ${(err as any).message}`,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }
}
