import type { Request, Response, NextFunction } from "express";
import { redis } from "./redis.js";
import { getLogger } from "./logger.js";

const logger = getLogger({ scope: "rate-limiter" });

const ATOMIC_INCR_EXPIRE_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if tonumber(current) == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return current
`;

export class RateLimitError extends Error {
  remainingPoints: number;
  msBeforeNext: number;

  constructor(msBeforeNext: number) {
    super(`Rate limit exceeded. Retry after ${Math.ceil(msBeforeNext / 1000)}s`);
    this.name = "RateLimitError";
    this.remainingPoints = 0;
    this.msBeforeNext = msBeforeNext;
  }
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export interface RateLimiterResult {
  remainingPoints: number;
  consumedPoints: number;
  msBeforeNext: number;
}

export interface RateLimiter {
  points: number;
  duration: number;
  consume(key: string, amount?: number): Promise<RateLimiterResult>;
  get(key: string): Promise<RateLimiterResult | null>;
  delete(key: string): Promise<boolean>;
  penalty(key: string, amount?: number): Promise<RateLimiterResult>;
}

interface LimiterOptions {
  keyPrefix: string;
  points: number;
  duration: number;
  blockDuration?: number;
}

function createUpstashLimiter({ keyPrefix, points, duration, blockDuration = 0 }: LimiterOptions): RateLimiter {
  const safePoints = toPositiveInt(points, 1);
  const safeDuration = toPositiveInt(duration, 60);
  const safeBlockDuration = Math.max(0, toPositiveInt(blockDuration, 0));

  const buildKey = (key: string) => `${keyPrefix}:${String(key || "unknown")}`;
  const buildBlockKey = (key: string) => `${buildKey(key)}:blocked`;

  return {
    points: safePoints,
    duration: safeDuration,

    async consume(key: string, amount = 1) {
      const consumeAmount = Math.max(1, toPositiveInt(amount, 1));
      const rlKey = buildKey(key);
      const blockKey = buildBlockKey(key);

      const blockedTtl = await redis.ttl(blockKey);
      if (Number(blockedTtl) > 0) {
        throw new RateLimitError(Number(blockedTtl) * 1000);
      }

      const current = await redis.eval(
        ATOMIC_INCR_EXPIRE_SCRIPT,
        [rlKey],
        [String(safeDuration)],
      ) as number;

      const ttl = await redis.ttl(rlKey);
      const remainingPoints = Math.max(0, safePoints - Number(current));
      const msBeforeNext = Math.max(1, (Number(ttl) > 0 ? Number(ttl) : safeDuration) * 1000);

      if (Number(current) > safePoints) {
        if (safeBlockDuration > 0) {
          await redis.set(blockKey, "1", { ex: safeBlockDuration });
        }
        throw new RateLimitError(
          safeBlockDuration > 0 ? safeBlockDuration * 1000 : msBeforeNext,
        );
      }

      return {
        remainingPoints,
        consumedPoints: Number(current),
        msBeforeNext,
      };
    },

    async get(key: string) {
      const rlKey = buildKey(key);
      const blockKey = buildBlockKey(key);

      const blockedTtl = await redis.ttl(blockKey);
      if (Number(blockedTtl) > 0) {
        return {
          remainingPoints: 0,
          consumedPoints: safePoints,
          msBeforeNext: Number(blockedTtl) * 1000,
        };
      }

      const raw = await redis.get(rlKey);
      const consumedPoints = Math.max(0, Number(raw) || 0);
      if (!consumedPoints) return null;

      const ttl = await redis.ttl(rlKey);
      return {
        remainingPoints: Math.max(0, safePoints - consumedPoints),
        consumedPoints,
        msBeforeNext: Math.max(1, (Number(ttl) > 0 ? Number(ttl) : safeDuration) * 1000),
      };
    },

    async delete(key: string) {
      const rlKey = buildKey(key);
      const blockKey = buildBlockKey(key);
      await Promise.all([
        redis.del(rlKey),
        redis.del(blockKey),
      ]);
      return true;
    },

    async penalty(key: string, amount = 1) {
      return this.consume(key, amount);
    },
  };
}

// Rate limiter configurations
export const rateLimiters: Record<string, RateLimiter> = {
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

export interface MiddlewareOptions {
  keyGenerator?: (req: Request) => string;
  onRateLimited?: (req: Request, res: Response, next: NextFunction, info: RateLimiterResult | { msBeforeNext: number }) => void;
}

/**
 * Middleware factory for Express.
 */
export function createRateLimitMiddleware(limiter: RateLimiter, options: MiddlewareOptions = {}) {
  const {
    keyGenerator = (req: Request) => req.ip || req.socket?.remoteAddress || "unknown",
    onRateLimited = null,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
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
    } catch (rejRes: unknown) {
      const rateLimitInfo = rejRes as RateLimitError | { msBeforeNext?: number };
      const secs = Math.max(1, Math.round((rateLimitInfo.msBeforeNext || 1000) / 1000));

      res.setHeader("Retry-After", secs);
      res.setHeader("X-RateLimit-Limit", limiter.points);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("X-RateLimit-Reset", Math.ceil(Date.now() / 1000) + secs);

      if (typeof onRateLimited === "function") {
        return onRateLimited(req, res, next, rejRes as { msBeforeNext: number });
      }

      return res.status(429).json({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Try again in ${secs} seconds.`,
        retryAfter: secs,
      });
    }
  };
}

export const rateLimitMiddleware: Record<string, ReturnType<typeof createRateLimitMiddleware>> = {
  standard: createRateLimitMiddleware(rateLimiters.standard),
  strict: createRateLimitMiddleware(rateLimiters.strict),

  auth: createRateLimitMiddleware(rateLimiters.auth, {
    keyGenerator: (req) => {
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      const ua = (req.headers["user-agent"] as string | undefined) || "";
      return `${ip}:${ua.slice(0, 20)}`;
    },
  }),

  cron: createRateLimitMiddleware(rateLimiters.cron, {
    keyGenerator: (req) => {
      const auth = req.headers.authorization || "";
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
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
      const guild = (body as { guild?: { id?: string } }).guild;
      const guildId = (body as { guild_id?: string }).guild_id || guild?.id || "unknown";
      return guildId;
    },
  }),
};


