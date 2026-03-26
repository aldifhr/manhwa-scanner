import { normalizeTitleKey } from "../domain/manga.js";
import { editInteractionResponse } from "../discord.js";

export default async function handleReadClear(payload, options, res, redis) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const query = options?.find(o => o.name === "judul")?.value;

  if (!query) {
    return res.json({
      type: 4,
      data: { content: "Masukkan judul manga yang ingin dihapus dari progres.", flags: 64 }
    });
  }

  const titleKey = normalizeTitleKey(query);
  const progressKey = `user:progress:${userId}:${titleKey}`;
  const indexKey = `user:progress_list:${userId}`;

  res.json({ type: 5, data: { flags: 64 } });

  try {
    const existing = await redis.get(progressKey);
    if (!existing) {
      await redis.zrem(indexKey, titleKey); // Cleanup index just in case
      return editInteractionResponse(payload, `Progres untuk **${query}** tidak ditemukan.`);
    }

    const title = existing.title || query;

    await Promise.all([
      redis.del(progressKey),
      redis.zrem(indexKey, titleKey)
    ]);

    return editInteractionResponse(payload, `✅ Berhasil menghapus **${title}** dari progres baca kamu.`);
  } catch (err) {
    console.error("[handleReadClear] Error:", err);
    return editInteractionResponse(payload, `Error: ${err.message}`);
  }
}
