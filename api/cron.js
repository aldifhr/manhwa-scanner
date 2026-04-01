import { isCronAuthorized } from "../lib/auth.js";
import { buildCronErrorLog, appendCronLog } from "../lib/cronLogs.js";
import { runCronJob, shouldRunChannelValidation } from "../lib/cronRuntime.js";
import { getLogger } from "../lib/logger.js";
import { writeCronStatus } from "../lib/monitorStore.js";
import { redis, getAllGuildChannels } from "../lib/redis.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { performFullHealthCheck } from "../lib/services/health.js";
import { sendDiscordEmbed } from "../lib/discord.js";

export const config = { maxDuration: 300 }; // 5 minutes max
const logger = getLogger({ scope: "cron" });

export { shouldRunChannelValidation };

async function handleUpdateCron(req, res, reqLogger) {
  try {
    const result = await runCronJob({ redisClient: redis, logger });
    logApiOk(reqLogger, { status: result.statusCode, ...result.logMeta });
    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    logger.error({ err: err.message }, "fatal");
    const statusPayload = {
      sent: 0, skipped: 0, failed: 1, duration: null, guilds: 0,
      timestamp: new Date().toISOString(), sourceHealth: {}, scrapeMetrics: null,
      outcome: "fatal_error", shortCircuitReason: "fatal_error", error: err?.message || "Internal error",
    };
    await writeCronStatus(redis, statusPayload).catch(() => {});
    await appendCronLog(redis, buildCronErrorLog(err, { code: "cron_fatal", type: "runtime_error", source: "cron" })).catch(() => {});
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({ error: "Internal error" });
  }
}

async function handleHealthCron(req, res, reqLogger) {
  const start = Date.now();
  logger.info("Starting scheduled link health check...");
  try {
    const deadLinks = await performFullHealthCheck();
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    logger.info({ dead: deadLinks.length, duration }, "Link check complete");

    if (deadLinks.length > 0) {
      const guildChannels = await getAllGuildChannels().catch(() => ({}));
      const channelIds = Object.values(guildChannels || {}).filter(Boolean);

      if (channelIds.length > 0) {
        const deadListStr = deadLinks.slice(0, 15).map(d => `• **${d.title}** (${d.source}): ${d.url}`).join("\n");
        const suffix = deadLinks.length > 15 ? `\n...dan ${deadLinks.length - 15} lainnya.` : "";
        const embed = {
          title: "⚠️ Laporan Link Mati (Bi-Weekly)",
          description: `Ditemukan **${deadLinks.length}** link yang tidak aktif di whitelist.\n\n${deadListStr}${suffix}`,
          color: 0xe74c3c,
          footer: { text: "Hapus link mati menggunakan /remove <Judul>." },
          timestamp: new Date().toISOString()
        };

        await Promise.all(
          channelIds.map(channelId =>
            sendDiscordEmbed(channelId, embed).catch(err => logger.warn({ channelId, err: err.message }, "Failed to send dead link alert"))
          )
        );
      }
    }

    logApiOk(reqLogger, { status: 200, dead: deadLinks.length });
    return res.status(200).json({ ok: true, dead: deadLinks.length, duration: `${duration}s` });
  } catch (err) {
    logger.error({ err: err.message }, "Scheduled link check failed");
    logApiError(reqLogger, err, { status: 500 });
    return res.status(500).json({ error: err.message });
  }
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("cron", req);

  if (!["GET", "POST"].includes(req.method)) {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const action = req.query.action || "update";
  if (action === "health" || action === "links") {
    return handleHealthCron(req, res, reqLogger);
  }
  return handleUpdateCron(req, res, reqLogger);
}
