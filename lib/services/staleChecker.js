/**
 * STALE MANGA CHECKER
 * Deteksi manga yang sudah lama tidak update (>30 hari)
 * dan kirim ephemeral followup ke interaksi yang sedang berjalan.
 * Pesan HANYA bisa dilihat oleh orang yang menjalankan command (owner).
 */

import { httpPost } from "../httpClient.js";
import { normalizeMarkReason } from "../domain.js";
import { normalizeTitleKey } from "../domain.js";

const STALE_THRESHOLD_DAYS = 30;
const WARN_TTL_SEC = 7 * 24 * 60 * 60; // 7 hari, biar tidak spam
const APP_ID = process.env.DISCORD_APPLICATION_ID;

/**
 * Kirim ephemeral followup ke interaksi aktif.
 * Hanya terlihat oleh user yang menjalankan command.
 */
async function sendEphemeralFollowup(token, content) {
  if (!APP_ID || !token) return;
  try {
    await httpPost(
      `https://discord.com/api/v10/webhooks/${APP_ID}/${token}`,
      { content, flags: 64 },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 8000,
      },
    );
  } catch (err) {
    console.warn("[staleChecker] Gagal kirim ephemeral followup:", err.message);
  }
}

/**
 * Entry point utama — dipanggil setelah dispatch selesai.
 * @param {Object} redis
 * @param {Array} whitelist - Array dari loadWhitelist()
 * @param {Object} payload - Discord interaction payload (untuk ephemeral followup)
 */
export async function checkStaleMangas(redis, whitelist, payload) {
  if (!redis || !whitelist?.length || !payload?.token) return;

  const nowMs = Date.now();
  const thresholdMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  // Filter: hanya yang tidak punya mark Hiatus/End
  const activeItems = whitelist.filter((item) => {
    const isMarked = (item.sources || []).some((s) => {
      const m = normalizeMarkReason(s.mark);
      return m === "hiatus" || m === "end" || m === "end_season";
    });
    return !isMarked;
  });

  if (!activeItems.length) return;

  // Batch-fetch last update timestamps
  const titleKeys = activeItems.map((item) => normalizeTitleKey(item.title));
  let timestamps = [];
  try {
    timestamps = await redis.hmget("manga:last_updates", ...titleKeys);
  } catch (err) {
    console.warn("[staleChecker] Gagal mget timestamps:", err.message);
    return;
  }

  // Identifikasi yang stale
  const staleItems = [];
  for (let i = 0; i < activeItems.length; i++) {
    const ts = timestamps[i];
    if (!ts) continue; // Belum pernah tercatat update, skip

    const lastUpdateMs = new Date(ts).getTime();
    if (isNaN(lastUpdateMs)) continue;

    const diffMs = nowMs - lastUpdateMs;
    if (diffMs <= thresholdMs) continue;

    const daysSince = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    const titleKey = titleKeys[i];

    // Cek apakah sudah pernah diperingatkan dalam 7 hari terakhir
    const warnKey = `stale:warned:${titleKey}`;
    try {
      const alreadyWarned = await redis.get(warnKey);
      if (alreadyWarned) continue;
    } catch {
      continue;
    }

    staleItems.push({ title: activeItems[i].title, titleKey, daysSince });
  }

  if (!staleItems.length) return;

  // Bangun pesan
  const lines = staleItems
    .slice(0, 20)
    .map(({ title, daysSince }) =>
      `• **${title}** — tidak update selama **${daysSince} hari**`,
    )
    .join("\n");

  const overflow =
    staleItems.length > 20
      ? `\n_...dan ${staleItems.length - 20} manga lainnya._`
      : "";

  const content =
    `⚠️ **Peringatan Stale (hanya terlihat olehmu):**\n\n` +
    `Manga berikut tidak ada update lebih dari ${STALE_THRESHOLD_DAYS} hari:\n\n` +
    lines +
    overflow +
    `\n\nGunakan \`/mark\` untuk menandai sebagai Hiatus jika perlu.`;

  // Kirim sebagai ephemeral followup (invisible ke orang lain)
  await sendEphemeralFollowup(payload.token, content);

  // Set warn flag agar tidak spam selama 7 hari
  await Promise.all(
    staleItems.map(({ titleKey }) =>
      redis
        .set(`stale:warned:${titleKey}`, "1", { ex: WARN_TTL_SEC })
        .catch(() => {}),
    ),
  );

  console.log(
    `[staleChecker] Ephemeral stale warning dikirim untuk ${staleItems.length} manga.`,
  );
}
