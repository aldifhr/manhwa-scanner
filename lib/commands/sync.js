import { waitUntil } from "@vercel/functions";
import { redis, loadWhitelist } from "../redis.js";
import { editInteractionResponse, sendDiscordEmbed } from "../discord.js";
import { scrapeMangaUpdates } from "../scrapers/orchestrator.js";
import { dispatchChapters, prepareDispatchQueue, loadMatchedDispatchContext } from "../services/dispatch.js";
import { checkStaleMangas } from "../services/staleChecker.js";
import { getLogger } from "../logger.js";
import {
  CHAPTER_TTL_SEC,
  RESYNC_DEFAULT_MAX_SEND,
  RESYNC_LOCK_TTL_SEC
} from "../config.js";
import { isGuildAdmin, isOwner } from "../permissions.js";
import { buildScrapeOptions } from "../services/scrapePreferences.js";
import { normalizeSource, normalizeSourceUrl } from "../domain.js";
import { getChapterNumber, normalizeTitleKey } from "../domain.js";

const LOCK_KEY = "job:sync:lock";
const logger = getLogger({ scope: "sync" });

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

function buildResyncGroupKey(item) {
  const source = normalizeSource(item?.source);
  const url = normalizeSourceUrl(item?.mangaUrl || "");
  return url ? `${source}::${url}` : `${source}::${normalizeTitleKey(item?.title || "")}`;
}

export function sortMatchedChapters(items = []) {
  const grouped = new Map();
  for (const item of items) {
    const key = buildResyncGroupKey(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, group]) =>
      [...group].sort((a, b) => {
        const delta = getChapterNumber(a.chapter) - getChapterNumber(b.chapter);
        if (delta !== 0) return delta;
        const ua = new Date(a?.updatedTime).getTime();
        const ub = new Date(b?.updatedTime).getTime();
        if (!Number.isNaN(ua) && !Number.isNaN(ub) && ua !== ub) return ua - ub;
        return String(a?.chapter || "").localeCompare(String(b?.chapter || ""), undefined, { numeric: true });
      })
    );
}

async function handleQuickSync(payload) {
  try {
    const context = await loadMatchedDispatchContext({
      scrapeUpdates: (whitelist) => scrapeMangaUpdates(redis, buildScrapeOptions(whitelist)),
    });

    if (context.status === "empty_whitelist") return editInteractionResponse(payload, "Whitelist kosong!");
    if (context.status === "no_channels") return editInteractionResponse(payload, "Belum ada notification channel.");
    if (context.status === "no_matches") return editInteractionResponse(payload, "Tidak ada chapter baru saat ini.");

    const { sent, skipped, failed } = await dispatchChapters({
      redis, matched: context.matched, channelIds: context.channelIds,
      sendEmbed: sendDiscordEmbed, chapterTtl: CHAPTER_TTL_SEC,
      log: (msg) => logger.debug({ msg }, "quick_sync"),
    });

    const msg = sent > 0
      ? `✅ **${sent}** chapter terkirim (dari **${context.matched.length}** rilis baru).\nDiskip: **${skipped}**, Gagal: **${failed}**`
      : `Tidak ada chapter terkirim.\nDiskip: **${skipped}**, Gagal: **${failed}**`;
    await editInteractionResponse(payload, msg);
  } catch (err) {
    logger.error({ err: err.message }, "quick_sync_failed");
    await editInteractionResponse(payload, `❌ Quick Sync Gagal: ${err.message}`);
  }
}

async function handleDeepSync(payload, options) {
  if (!isOwner(payload)) return editInteractionResponse(payload, "❌ Mode `deep` hanya untuk owner bot.");

  const dryRun = Boolean(getOption(options, "dry_run"));
  const maxSend = Number(getOption(options, "max_send")) || RESYNC_DEFAULT_MAX_SEND;

  const lockVal = { by: payload.member?.user?.id ?? payload.user?.id, at: new Date().toISOString() };
  if (!(await redis.set(LOCK_KEY, lockVal, { nx: true, ex: RESYNC_LOCK_TTL_SEC }))) {
    return editInteractionResponse(payload, "Sync sedang berjalan. Tunggu beberapa menit.");
  }

  try {
    const context = await loadMatchedDispatchContext({
      scrapeUpdates: (whitelist) => scrapeMangaUpdates(redis, buildScrapeOptions(whitelist)),
      prioritizeChannels: true,
    });

    if (context.status === "no_matches") return editInteractionResponse(payload, "Tidak ada data rilis <24h untuk di-resync.");
    if (context.status !== "ok") return editInteractionResponse(payload, `Sync dihentikan: ${context.status}`);

    const sorted = sortMatchedChapters(context.matched);
    if (dryRun) {
      const q = await prepareDispatchQueue(redis, sorted, maxSend);
      return editInteractionResponse(payload, `🔍 **Dry Run Deep Sync**\nMatched: ${sorted.length}\nWould Send: ${q.unsentMeta.length}\nAlready Sent: ${q.alreadySentCount}`);
    }

    const { sent, skipped, failed, processed } = await dispatchChapters({
      redis, matched: sorted, channelIds: context.channelIds,
      sendEmbed: sendDiscordEmbed, chapterTtl: CHAPTER_TTL_SEC, maxItems: maxSend,
      log: (msg) => logger.debug({ msg }, "deep_sync"),
    });

    await editInteractionResponse(payload, `✅ **Deep Sync Selesai**\nProcessed: ${processed}, Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}`);

    const whitelist = await loadWhitelist().catch(() => []);
    await checkStaleMangas(redis, whitelist, payload).catch(() => { });
  } catch (err) {
    logger.error({ err: err.message }, "deep_sync_failed");
    await editInteractionResponse(payload, `❌ Deep Sync Gagal: ${err.message}`);
  } finally {
    await redis.del(LOCK_KEY);
  }
}

export default function handleSync(payload, options, res) {
  if (!isGuildAdmin(payload)) {
    return res.json({ type: 4, data: { content: "Hanya admin yang bisa menjalankan sync.", flags: 64 } });
  }

  const mode = (getOption(options, "mode") || (payload.data?.name === "resync24h" ? "deep" : "quick"));
  res.json({ type: 5, data: { flags: 64 } });

  waitUntil((async () => {
    if (mode === "deep") await handleDeepSync(payload, options);
    else await handleQuickSync(payload, options);
  })());
}
