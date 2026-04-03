import { InteractionResponseType } from "discord-interactions";

export default async function handleReadClear(payload, options, res, redis) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  if (!userId) {
    return res.json({ type: 4, data: { content: "❌ Tidak dapat mengidentifikasi user.", flags: 64 } });
  }

  try {
    const progressDataKey = `user:progress_data:${userId}`;
    const indexKey = `user:progress_list:${userId}`;
    
    // Check if user has progress first
    const hasProgress = await redis.zcard(indexKey);
    if (!hasProgress) {
        return res.json({ type: 4, data: { content: "📋 Kamu tidak memiliki data history progres baca saat ini.", flags: 64 } });
    }

    await Promise.all([
      redis.del(progressDataKey),
      redis.del(indexKey)
    ]);

    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "✅ Seluruh data history progres baca kamu berhasil dihapus.", flags: 64 },
    });
  } catch (err) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `❌ Gagal menghapus progres: ${err.message}`, flags: 64 },
    });
  }
}
