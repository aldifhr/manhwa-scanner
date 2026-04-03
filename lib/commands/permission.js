import { InteractionResponseType } from "discord-interactions";
import { isGuildAdmin, isOwner } from "../permissions.js";

export default async function handlePermission(payload, options, res, redis) {
  // Only Admin or Owner can manage permissions
  if (!isGuildAdmin(payload) && !isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Command ini hanya bisa dijalankan oleh Admin server atau Owner bot.", flags: 64 },
    });
  }

  const action = options?.[0]?.value || options?.[0]?.options?.find(o => o.name === "action")?.value;
  const userOption = options?.[0]?.options?.find(o => o.name === "user")?.value;

  if (action === "list") {
    const allowed = await redis.smembers("whitelist:allowed_users");
    if (!allowed || allowed.length === 0) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "📋 Daftar user yang diizinkan kosong (hanya default owner/admin).", flags: 64 },
      });
    }

    const mentions = allowed.map(id => `<@${id}>`).join(", ");
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `📋 **User yang Diizinkan /add:**\n${mentions}`, flags: 64 },
    });
  }

  if (!userOption) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Pilih user yang ingin dikelola.", flags: 64 },
    });
  }

  try {
    if (action === "add") {
      await redis.sadd("whitelist:allowed_users", userOption);
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `✅ Berhasil menambahkan <@${userOption}> ke daftar izin /add.`, flags: 64 },
      });
    } else if (action === "remove") {
      await redis.srem("whitelist:allowed_users", userOption);
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `✅ Berhasil menghapus <@${userOption}> dari daftar izin /add.`, flags: 64 },
      });
    }
  } catch (err) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Terjadi kesalahan: ${err.message}`, flags: 64 },
    });
  }

  return res.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Tindakan tidak dikenal.", flags: 64 },
  });
}
