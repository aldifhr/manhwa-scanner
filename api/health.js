import { isCronAuthorized } from "../lib/auth.js";
import { performFullHealthCheck } from "../lib/services/health.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { getAllGuildChannels, redis } from "../lib/redis.js";
import { sendDiscordEmbed } from "../lib/discord.js";
import {
  createErrorResponse,
  createSuccessResponse,
} from "../lib/api/response.js";

// Constants for response limits
const MAX_BROKEN_LINKS_DISPLAY = 50;
const MAX_RECOMMENDATIONS_DISPLAY = 20;

// Build-time constant for Vercel bundler compatibility
// NOTE: Must use literal value, not imported constant (Vercel bundler limitation)
// Using 30s for FastCron free tier compatibility (consistent with api/cron.js)
export const config = { maxDuration: 30 };

const VALID_METHODS = ["GET", "POST"];

export default async function handler(req, res) {
  const reqLogger = logApiHit("health", req);

  // Method validation
  if (!VALID_METHODS.includes(req.method)) {
    logApiOk(reqLogger, { status: 405, reason: "method_not_allowed" });
    return res
      .status(405)
      .json(createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed"));
  }

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res
      .status(401)
      .json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  try {
    const brokenLinks = await performFullHealthCheck();

    // Properly parse recommendations from Redis (JSON string)
    const rawRecommendations = await redis.get("health:recommendations");
    const recommendations = rawRecommendations
      ? JSON.parse(rawRecommendations)
      : [];

    if (brokenLinks.length > 0) {
      // Error handling for getAllGuildChannels (consistent with cron.js)
      const guildChannels = await getAllGuildChannels().catch(() => ({}));

      let msg = `⚠️ **Daily Health Audit**
Found **${brokenLinks.length}** broken links in your whitelist.`;

      if (recommendations.length > 0) {
        msg += `\n\n💡 **Action Needed**: Found **${recommendations.length}** links with persistent failures. Consider removing them.`;
      }

      msg += "\n\nUse `/health` or check the Dashboard for details.";

      const embed = {
        title: "Broken Link Alert",
        description: msg,
        color: 0xff0000,
      };

      // Parallel Discord alerts (consistent with cron.js)
      await Promise.all(
        Object.values(guildChannels).map((channelId) =>
          sendDiscordEmbed(channelId, embed).catch((err) => {
            reqLogger.warn(
              { channelId, err: err.message },
              "Failed to send health alert",
            );
          }),
        ),
      );
    }

    logApiOk(reqLogger, {
      status: 200,
      brokenCount: brokenLinks.length,
      recommendations: recommendations.length,
    });
    return res.status(200).json(
      createSuccessResponse({
        brokenCount: brokenLinks.length,
        brokenLinks: brokenLinks.slice(0, MAX_BROKEN_LINKS_DISPLAY),
        recommendations: recommendations.slice(0, MAX_RECOMMENDATIONS_DISPLAY),
        checkedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logApiError(reqLogger, err, { status: 500 });
    return res
      .status(500)
      .json(
        createErrorResponse(
          "HEALTH_CHECK_FAILED",
          process.env.NODE_ENV === "production"
            ? "Internal error"
            : err.message,
        ),
      );
  }
}
