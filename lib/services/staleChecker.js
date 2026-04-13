/**
 * STALE MANGA CHECKER
 * Deteksi manga yang sudah lama tidak update (>30 hari)
 * dan kirim ephemeral followup ke interaksi yang sedang berjalan.
 * Pesan HANYA bisa dilihat oleh orang yang menjalankan command (owner).
 */

import { httpPost } from "../httpClient.js";
import { normalizeMarkReason } from "../domain.js";
import { normalizeTitleKey } from "../domain.js";
import { getLogger } from "../logger.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { MANGA_LAST_UPDATES_KEY, MANGA_STALE_WARNED_KEY } from "../redis.js";

const logger = getLogger({ scope: "staleChecker" });

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
      { content, flags: DISCORD_EPHEMERAL_FLAG },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 8000,
      },
    );
  } catch (err) {
    logger.warn({ error: err.message }, "Gagal kirim ephemeral followup");
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
    timestamps = await redis.hmget(MANGA_LAST_UPDATES_KEY, ...titleKeys);
    if (!timestamps) {
      timestamps = []; // No data yet, treat all as never updated
    } else if (!Array.isArray(timestamps) && typeof timestamps === "object") {
      timestamps = titleKeys.map((tk) => timestamps[tk]);
    }
  } catch (err) {
    logger.warn({ error: err.message }, "Gagal mget timestamps");
    return;
  }

  let warningsCache = [];
  try {
    warningsCache = await redis.hmget(MANGA_STALE_WARNED_KEY, ...titleKeys);
    if (
      warningsCache &&
      !Array.isArray(warningsCache) &&
      typeof warningsCache === "object"
    ) {
      warningsCache = titleKeys.map((tk) => warningsCache[tk]);
    }
  } catch {
    // Ignore
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
    const warnedData = warningsCache[i];
    if (warnedData) {
      const parsed =
        typeof warnedData === "string" ? JSON.parse(warnedData) : warnedData;
      if (parsed && parsed.expiresAt > nowMs) {
        continue; // Still actively warned
      }
    }

    staleItems.push({ title: activeItems[i].title, titleKey, daysSince });
  }

  if (!staleItems.length) return;

  // Bangun pesan
  const lines = staleItems
    .slice(0, 20)
    .map(
      ({ title, daysSince }) =>
        `• **${title}** — tidak update selama **${daysSince} hari**`,
    )
    .join("\n");

  const overflow =
    staleItems.length > 20
      ? `\n_...dan ${staleItems.length - 20} manga lainnya._`
      : "";

  const content =
    "⚠️ **Peringatan Stale (hanya terlihat olehmu):**\n\n" +
    `Manga berikut tidak ada update lebih dari ${STALE_THRESHOLD_DAYS} hari:\n\n${
      lines
    }${overflow}`;

  // Kirim sebagai ephemeral followup (invisible ke orang lain)
  await sendEphemeralFollowup(payload.token, content);

  // Set warn flag agar tidak spam selama 7 hari
  if (staleItems.length > 0) {
    const expiredAt = Date.now() + WARN_TTL_SEC * 1000;
    const warnsObj = {};
    staleItems.forEach(({ titleKey }) => {
      warnsObj[titleKey] = JSON.stringify({ expiresAt: expiredAt });
    });
    await redis.hset(MANGA_STALE_WARNED_KEY, warnsObj).catch(() => {});
  }

  // Cleanup expired entries periodically (fire and forget)
  // Use batching to prevent Redis command limits with large arrays
  redis
    .hgetall(MANGA_STALE_WARNED_KEY)
    .then((allFields) => {
      if (allFields && typeof allFields === "object") {
        const toDelete = [];
        const nMs = Date.now();
        for (const [k, v] of Object.entries(allFields)) {
          try {
            const parsed = typeof v === "string" ? JSON.parse(v) : v;
            if (parsed && parsed.expiresAt < nMs) toDelete.push(k);
          } catch (e) {
            /* ignore */
          }
        }
        // Batch deletes in chunks of 100 to prevent Redis command limits
        const BATCH_SIZE = 100;
        if (toDelete.length > 0) {
          const deleteBatches = [];
          for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
            const batch = toDelete.slice(i, i + BATCH_SIZE);
            deleteBatches.push(redis.hdel(MANGA_STALE_WARNED_KEY, ...batch).catch(() => {}));
          }
          Promise.all(deleteBatches).catch(() => {});
        }
      }
    })
    .catch(() => {
      /* ignore */
    });

  logger.info({ count: staleItems.length }, "Ephemeral stale warning dikirim");
}
