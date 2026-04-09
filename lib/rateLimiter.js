import { redis } from "./redis.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "rate-limiter" });

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function createUpstashLimiter({ keyPrefix, points, duration, blockDuration = 0 }) {
  const safePoints = toPositiveInt(points, 1);
  const safeDuration = toPositiveInt(duration, 60);
  const safeBlockDuration = Math.max(0, toPositiveInt(blockDuration, 0));

  const buildKey = (key) => `${keyPrefix}:${String(key || "unknown")}`;
  const buildBlockKey = (key) => `${buildKey(key)}:blocked`;

  return {
    points: safePoints,
    duration: safeDuration,

    async consume(key, amount = 1) {
      const consumeAmount = Math.max(1, toPositiveInt(amount, 1));
      const rlKey = buildKey(key);
      const blockKey = buildBlockKey(key);

      const blockedTtl = await redis.ttl(blockKey).catch(() => -2);
      if (Number(blockedTtl) > 0) {
        throw {
          remainingPoints: 0,
          msBeforeNext: Number(blockedTtl) * 1000,
        };
      }

      const current = await redis.incr(rlKey);
      if (Number(current) === consumeAmount) {
        await redis.expire(rlKey, safeDuration).catch(() => {});
      }

      const ttl = await redis.ttl(rlKey).catch(() => safeDuration);
      const remainingPoints = Math.max(0, safePoints - Number(current));
      const msBeforeNext = Math.max(1, (Number(ttl) > 0 ? Number(ttl) : safeDuration) * 1000);

      if (Number(current) > safePoints) {
        if (safeBlockDuration > 0) {
          await redis.set(blockKey, "1", { ex: safeBlockDuration }).catch(() => {});
        }
        throw {
          remainingPoints: 0,
          msBeforeNext:
            safeBlockDuration > 0 ? safeBlockDuration * 1000 : msBeforeNext,
        };
      }

      return {
        remainingPoints,
        consumedPoints: Number(current),
        msBeforeNext,
      };
    },

    async get(key) {
      const rlKey = buildKey(key);
      const blockKey = buildBlockKey(key);

      const blockedTtl = await redis.ttl(blockKey).catch(() => -2);
      if (Number(blockedTtl) > 0) {
        return {
          remainingPoints: 0,
          consumedPoints: safePoints,
          msBeforeNext: Number(blockedTtl) * 1000,
        };
      }

      const raw = await redis.get(rlKey).catch(() => null);
      const consumedPoints = Math.max(0, Number(raw) || 0);
      if (!consumedPoints) return null;

      const ttl = await redis.ttl(rlKey).catch(() => safeDuration);
      return {
        remainingPoints: Math.max(0, safePoints - consumedPoints),
        consumedPoints,
        msBeforeNext: Math.max(1, (Number(ttl) > 0 ? Number(ttl) : safeDuration) * 1000),
      };
    },

    async delete(key) {
      const rlKey = buildKey(key);
      const blockKey = buildBlockKey(key);
      await Promise.all([
        redis.del(rlKey).catch(() => 0),
        redis.del(blockKey).catch(() => 0),
      ]);
      return true;
    },

    async penalty(key, amount = 1) {
      return this.consume(key, amount);
    },
  };
}

// Rate limiter configurations
export const rateLimiters = {
  standard: createUpstashLimiter({
    keyPrefix: "rl_standard",
    points: 100,
    duration: 60,
    blockDuration: 60,
  }),

  strict: createUpstashLimiter({
    keyPrefix: "rl_strict",
    points: 10,
    duration: 60,
    blockDuration: 120,
  }),

  auth: createUpstashLimiter({
    keyPrefix: "rl_auth",
    points: 5,
    duration: 300,
    blockDuration: 600,
  }),

  cron: createUpstashLimiter({
    keyPrefix: "rl_cron",
    points: 10,
    duration: 60,
  }),

  discord: createUpstashLimiter({
    keyPrefix: "rl_discord",
    points: 50,
    duration: 60,
  }),
};

// Middleware factory for Express
export function createRateLimitMiddleware(limiter, options = {}) {
  const {
    keyGenerator = (req) => req.ip || req.connection.remoteAddress || "unknown",
    onRateLimited = null,
  } = options;

  return async (req, res, next) => {
    if (req.path === "/api/health" || req.path === "/api/health-status") {
      return next();
    }

    const key = keyGenerator(req);

    try {
      const consumeRes = await limiter.consume(key);
      const reset = Math.ceil(Date.now() / 1000) + Math.ceil(consumeRes.msBeforeNext / 1000);

      res.setHeader("X-RateLimit-Limit", limiter.points);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, consumeRes.remainingPoints));
      res.setHeader("X-RateLimit-Reset", reset);

      next();
    } catch (rejRes) {
      const secs = Math.max(1, Math.round((rejRes?.msBeforeNext || 1000) / 1000));

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

export const rateLimitMiddleware = {
  standard: createRateLimitMiddleware(rateLimiters.standard),
  strict: createRateLimitMiddleware(rateLimiters.strict),

  auth: createRateLimitMiddleware(rateLimiters.auth, {
    keyGenerator: (req) => {
      const ip = req.ip || req.connection.remoteAddress || "unknown";
      const ua = req.headers["user-agent"] || "";
      return `${ip}:${ua.slice(0, 20)}`;
    },
  }),

  cron: createRateLimitMiddleware(rateLimiters.cron, {
    keyGenerator: (req) => {
      const auth = req.headers.authorization || "";
      const ip = req.ip || req.connection.remoteAddress || "unknown";
      return auth ? `auth:${auth.slice(-10)}` : `ip:${ip}`;
    },
    onRateLimited: (_req, res) =>
      res.status(429).json({
        error: "CRON_RATE_LIMITED",
        message: "Too many cron requests. Please wait.",
      }),
  }),

  discord: createRateLimitMiddleware(rateLimiters.discord, {
    keyGenerator: (req) => {
      const body = req.body || {};
      const guildId = body.guild_id || body.guild?.id || "unknown";
      return guildId;
    },
  }),
};

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
        (res ? Math.ceil(res.msBeforeNext / 1000) : limiter.duration),
    };
  } catch (err) {
    logger.warn({ limiterName, key, err: err.message }, "checkRateLimit fallback allow");
    return { allowed: true, remaining: limiter.points };
  }
}

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
