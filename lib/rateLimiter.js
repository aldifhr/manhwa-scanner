import { RateLimiterRedis } from "rate-limiter-flexible";
import { redis } from "./redis.js";

// Rate limiter configurations
export const rateLimiters = {
  // Standard API rate limiter: 100 requests per minute per IP
  standard: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl_standard",
    points: 100, // 100 requests
    duration: 60, // per 60 seconds
    blockDuration: 60, // Block for 60 seconds if exceeded
  }),

  // Strict rate limiter for sensitive endpoints: 10 requests per minute
  strict: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl_strict",
    points: 10,
    duration: 60,
    blockDuration: 120, // Block for 2 minutes
  }),

  // Very strict for auth endpoints: 5 requests per 5 minutes
  auth: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl_auth",
    points: 5,
    duration: 300, // 5 minutes
    blockDuration: 600, // Block for 10 minutes
  }),

  // Cron endpoint limiter: 10 requests per minute
  cron: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl_cron",
    points: 10,
    duration: 60,
  }),

  // Discord interactions limiter: 50 requests per minute per guild
  discord: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rl_discord",
    points: 50,
    duration: 60,
  }),
};

// Middleware factory for Express
export function createRateLimitMiddleware(limiter, options = {}) {
  const {
    keyGenerator = (req) => req.ip || req.connection.remoteAddress || "unknown",
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    onRateLimited = null,
  } = options;

  return async (req, res, next) => {
    // Skip rate limiting for health checks
    if (req.path === "/api/health" || req.path === "/api/health-status") {
      return next();
    }

    const key = keyGenerator(req);

    try {
      // Try to consume a point
      await limiter.consume(key);

      // Add rate limit headers
      const limit = limiter.points;
      const remaining = await limiter
        .get(key)
        .then((res) => res.remainingPoints)
        .catch(() => 0);
      const reset = Math.ceil(Date.now() / 1000) + limiter.duration;

      res.setHeader("X-RateLimit-Limit", limit);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining - 1));
      res.setHeader("X-RateLimit-Reset", reset);

      next();
    } catch (rejRes) {
      // Rate limit exceeded
      const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;

      res.setHeader("Retry-After", secs);
      res.setHeader("X-RateLimit-Limit", limiter.points);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("X-RateLimit-Reset", Math.ceil(Date.now() / 1000) + secs);

      if (typeof onRateLimited === "function") {
        return onRateLimited(req, res, next, rejRes);
      }

      return res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Try again in ${secs} seconds.`,
        retryAfter: secs,
      });
    }
  };
}

// Pre-configured middlewares
export const rateLimitMiddleware = {
  // Standard: 100 req/min per IP
  standard: createRateLimitMiddleware(rateLimiters.standard),

  // Strict: 10 req/min per IP
  strict: createRateLimitMiddleware(rateLimiters.strict),

  // Auth: 5 req/5min per IP
  auth: createRateLimitMiddleware(rateLimiters.auth, {
    keyGenerator: (req) => {
      // Use IP + user agent for auth endpoints
      const ip = req.ip || req.connection.remoteAddress || "unknown";
      const ua = req.headers["user-agent"] || "";
      return `${ip}:${ua.slice(0, 20)}`;
    },
  }),

  // Cron: 10 req/min with custom key
  cron: createRateLimitMiddleware(rateLimiters.cron, {
    keyGenerator: (req) => {
      // Use authorization header or IP
      const auth = req.headers.authorization || "";
      const ip = req.ip || req.connection.remoteAddress || "unknown";
      return auth ? `auth:${auth.slice(-10)}` : `ip:${ip}`;
    },
    onRateLimited: (req, res) => res.status(429).json({
      error: "CRON_RATE_LIMITED",
      message: "Too many cron requests. Please wait.",
    }),
  }),

  // Discord: 50 req/min per guild
  discord: createRateLimitMiddleware(rateLimiters.discord, {
    keyGenerator: (req) => {
      // Extract guild ID from request body for Discord interactions
      const body = req.body || {};
      const guildId = body.guild_id || body.guild?.id || "unknown";
      return guildId;
    },
  }),
};

// Check rate limit without consuming (for pre-flight checks)
export async function checkRateLimit(limiterName, key) {
  const limiter = rateLimiters[limiterName];
  if (!limiter) return { allowed: true, remaining: 0 };

  try {
    const res = await limiter.get(key);
    const remaining = res ? res.remainingPoints : limiter.points;
    return {
      allowed: remaining > 0,
      remaining,
      reset:
        Math.ceil(Date.now() / 1000) +
        (res ? res.msBeforeNext / 1000 : limiter.duration),
    };
  } catch {
    return { allowed: true, remaining: limiter.points };
  }
}

// Reset rate limit for a key (useful for admin operations)
export async function resetRateLimit(limiterName, key) {
  const limiter = rateLimiters[limiterName];
  if (!limiter) return false;

  try {
    await limiter.delete(key);
    return true;
  } catch {
    return false;
  }
}

// Penalty system - add penalty points for abuse
export async function addPenalty(limiterName, key, points = 1) {
  const limiter = rateLimiters[limiterName];
  if (!limiter) return false;

  try {
    await limiter.penalty(key, points);
    return true;
  } catch {
    return false;
  }
}

// Get rate limit info for display
export async function getRateLimitInfo(limiterName, key) {
  const limiter = rateLimiters[limiterName];
  if (!limiter) return null;

  try {
    const res = await limiter.get(key);
    if (!res) {
      return {
        limit: limiter.points,
        remaining: limiter.points,
        used: 0,
        reset: Math.ceil(Date.now() / 1000) + limiter.duration,
      };
    }

    return {
      limit: limiter.points,
      remaining: Math.max(0, res.remainingPoints),
      used: limiter.points - res.remainingPoints,
      reset: Math.ceil((Date.now() + res.msBeforeNext) / 1000),
      blocked: res.remainingPoints <= 0,
      blockDuration: res.msBeforeNext,
    };
  } catch {
    return null;
  }
}
