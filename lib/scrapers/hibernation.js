/**
 * HIBERNATION SERVICE
 * Mengelola logika "tidur" untuk manhwa yang sudah lama tidak update
 * untuk menghemat kuota eksekusi serverless.
 */

import { getLogger } from "../logger.js";

const DEFAULT_THRESHOLD_DAYS = 14;
const DEFAULT_WAKE_PROBABILITY = 0.05;

/**
 * Filter titleKeys yang harus di-skip karena masuk masa hibernasi.
 * 
 * @param {Object} redis Instance Redis
 * @param {string[]} titleKeys Array of normalized title keys
 * @param {Object} options Konfigurasi
 * @returns {Promise<Set<string>>} Set of title keys to skip
 */
export async function getHibernatingTitleKeys(redis, titleKeys, options = {}) {
  if (!redis || !titleKeys.length) return new Set();
  if (options.force === true || options.fullRefresh === true) return new Set();

  const logger = getLogger({ scope: "hibernation" });
  const nowMs = Date.now();
  const thresholdMs = (options.thresholdDays || DEFAULT_THRESHOLD_DAYS) * 24 * 60 * 60 * 1000;
  const wakeProb = options.wakeProbability !== undefined ? options.wakeProbability : DEFAULT_WAKE_PROBABILITY;

  const timestamps = await redis.hmget("manga:last_updates", ...titleKeys);
  
  const skipSet = new Set();
  
  for (let i = 0; i < titleKeys.length; i++) {
    const ts = timestamps[i];
    if (!ts) continue; // New or never updated

    const lastUpdateMs = new Date(ts).getTime();
    if (nowMs - lastUpdateMs > thresholdMs) {
      // Masuk kriteria hibernasi
      if (Math.random() >= wakeProb) {
        skipSet.add(titleKeys[i]);
      }
    }
  }

  if (skipSet.size > 0) {
    logger.info({ hibernatingCount: skipSet.size, totalChecked: titleKeys.length }, "identifying hibernation targets");
  }

  return skipSet;
}

/**
 * Update timestamp terakhir update untuk sebuah manhwa di Redis.
 * Dipanggil saat ada chapter baru terdeteksi (Wake-on-Update).
 */
export async function touchMangaUpdate(redis, titleKey) {
  if (!redis || !titleKey) return;
  await redis.hset("manga:last_updates", { [titleKey]: new Date().toISOString() });
}
