import { isCronAuthorized } from "../lib/auth.js";
import { performFullHealthCheck } from "../lib/services/health.js";
import { logApiHit, logApiOk, logApiError } from "../lib/logger.js";
import { redis, getAllGuildChannels } from "../lib/redis.js";
import { sendDiscordEmbed } from "../lib/discord.js";

export const config = { maxDuration: 300 }; // 5 minutes for deep health check

// Standard API response helpers
function createSuccessResponse(data) {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function createErrorResponse(code, message, details = null) {
  const response = {
    success: false,
    error: {
      code,
      message,
    },
    timestamp: new Date().toISOString(),
  };
  if (details) {
    response.error.details = details;
  }
  return response;
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("health", req);

  if (!isCronAuthorized(req)) {
    logApiOk(reqLogger, { status: 401, reason: "unauthorized" });
    return res
      .status(401)
      .json(createErrorResponse("UNAUTHORIZED", "Unauthorized"));
  }

  try {
    const brokenLinks = await performFullHealthCheck();
    const recommendations = (await redis.get("health:recommendations")) || [];

    if (brokenLinks.length > 0) {
      const guildChannels = await getAllGuildChannels();
      let msg = `⚠️ **Daily Health Audit**\nFound **${brokenLinks.length}** broken links in your whitelist.`;

      if (recommendations.length > 0) {
        msg += `\n\n💡 **Action Needed**: Found **${recommendations.length}** links with persistent failures. Consider removing them.`;
      }

      msg += `\n\nUse \`/health\` or check the Dashboard for details.`;

      for (const channelId of Object.values(guildChannels)) {
        await sendDiscordEmbed(
          {
            title: "Broken Link Alert",
            description: msg,
            color: 0xff0000,
          },
          channelId,
        ).catch(() => {});
      }
    }

    logApiOk(reqLogger, {
      status: 200,
      brokenCount: brokenLinks.length,
      recommendations: recommendations.length,
    });
    return res.status(200).json(
      createSuccessResponse({
        brokenCount: brokenLinks.length,
        brokenLinks: brokenLinks.slice(0, 50), // Limit response size
        recommendations: recommendations.slice(0, 20),
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
