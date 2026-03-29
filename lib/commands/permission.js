import { InteractionResponseType } from "discord-interactions";
import { editInteractionResponse } from "../discord.js";
import { isOwner } from "../permissions.js";

export default async function handlePermission(payload, options, res, redis) {
  if (!isOwner(payload)) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Command ini hanya untuk owner bot.", flags: 64 },
    });
  }

  const subcommand = options?.[0];
  const subOptions = subcommand?.options || [];
  const targetId = String(subOptions.find(o => o.name === "user_id")?.value || "").trim();

  res.json({ type: 5, data: { flags: 64 } });

  try {
    const key = "whitelist:allowed_users";

    if (subcommand.name === "add") {
      if (!targetId) throw new Error("User ID tidak valid.");
      await redis.sadd(key, targetId);
      return editInteractionResponse(payload, `✅ Berhasil memberikan akses \`/add\` kepada <@${targetId}> (${targetId}).`);
    }

    if (subcommand.name === "remove") {
      if (!targetId) throw new Error("User ID tidak valid.");
      await redis.srem(key, targetId);
      return editInteractionResponse(payload, `✅ Berhasil mencabut akses \`/add\` dari <@${targetId}> (${targetId}).`);
    }

    if (subcommand.name === "list") {
      const users = await redis.smembers(key);
      if (!users.length) {
        return editInteractionResponse(payload, "📋 Belum ada user tambahan di whitelist dinamis.");
      }
      const list = users.map(id => `• <@${id}> (\`${id}\`)`).join("\n");
      return editInteractionResponse(payload, `📋 **User dengan akses \`/add\` (Dinamis):**\n\n${list}`);
    }

    throw new Error("Subcommand tidak dikenal.");
  } catch (err) {
    return editInteractionResponse(payload, `❌ Terjadi kesalahan: ${err.message}`);
  }
}
