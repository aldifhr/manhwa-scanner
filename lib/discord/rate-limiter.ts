import Bottleneck from "bottleneck";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "discord:rate-limiter" });

// Discord rate limits: 50 requests per second per channel
// Conservative: 1 request per second to avoid 429 errors
export const discordLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000, // 1 request per second
});

// High priority limiter for urgent messages (e.g., errors)
export const discordPriorityLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500, // 2 requests per second
});

export async function withDiscordRateLimit<T>(
  fn: () => Promise<T>,
  priority: "normal" | "high" = "normal"
): Promise<T> {
  const limiter = priority === "high" ? discordPriorityLimiter : discordLimiter;
  return limiter.schedule(fn);
}
