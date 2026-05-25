/**
 * Redis client types for Upstash Redis and graceful fallback
 */

export type RedisValue = string | number | Buffer;

export type RedisHashFieldValue = string | number;

export interface RedisSetOptions {
  ex?: number;
  px?: number;
  exat?: number;
  pxat?: number;
  nx?: boolean;
  xx?: boolean;
  keepttl?: boolean;
  get?: boolean;
}

export interface RedisZRangeOptions {
  withScores?: boolean;
  rev?: boolean;
  by?: "score" | "lex";
  limit?: { offset: number; count: number };
}

export interface RedisScanOptions {
  match?: string;
  count?: number;
  type?: string;
}

export interface RedisPipeline {
  get: (key: string) => RedisPipeline;
  set: (key: string, value: RedisValue, options?: RedisSetOptions) => RedisPipeline;
  del: (...keys: string[]) => RedisPipeline;
  hget: (key: string, field: string) => RedisPipeline;
  hgetall: (key: string) => RedisPipeline;
  hset: (key: string, fields: Record<string, RedisHashFieldValue>) => RedisPipeline;
  hsetnx: (key: string, field: string, value: string) => RedisPipeline;
  hdel: (key: string, ...fields: string[]) => RedisPipeline;
  hmget: (key: string, ...fields: string[]) => RedisPipeline;
  hlen: (key: string) => RedisPipeline;
  httl: (key: string) => RedisPipeline;
  zadd: (key: string, ...args: (string | number | { score: number; member: string })[]) => RedisPipeline;
  zrem: (key: string, ...members: string[]) => RedisPipeline;
  zrange: (key: string, start: number, stop: number, options?: { rev?: boolean }) => RedisPipeline;
  expire: (key: string, seconds: number) => RedisPipeline;
  hexpire: (key: string, seconds: number, mode: "NX" | "XX" | "GT" | "LT" | "FIELDS", fieldCount: number, ...fields: string[]) => RedisPipeline;
  hpexpire: (key: string, milliseconds: number, mode: "NX" | "XX" | "GT" | "LT" | "FIELDS", fieldCount: number, ...fields: string[]) => RedisPipeline;
  lpush: (key: string, ...elements: RedisValue[]) => RedisPipeline;
  rpush: (key: string, ...elements: RedisValue[]) => RedisPipeline;
  lrange: (key: string, start: number, stop: number) => RedisPipeline;
  ltrim: (key: string, start: number, stop: number) => RedisPipeline;
  llen: (key: string) => RedisPipeline;
  zremrangebyscore: (key: string, min: number | string, max: number | string) => RedisPipeline;
  zremrangebyrank: (key: string, start: number, stop: number) => RedisPipeline;
  lrem: (key: string, count: number, element: string) => RedisPipeline;
  lmove: (source: string, destination: string, from: "LEFT" | "RIGHT", to: "LEFT" | "RIGHT") => RedisPipeline;
  smembers: (key: string) => RedisPipeline;
  sadd: (key: string, ...members: string[]) => RedisPipeline;
  srem: (key: string, ...members: string[]) => RedisPipeline;
  scard: (key: string) => RedisPipeline;
  mget: (...keys: string[]) => RedisPipeline;
  incr: (key: string) => RedisPipeline;
  decr: (key: string) => RedisPipeline;
  eval: (script: string, keys: string[], args: RedisValue[]) => RedisPipeline;
  exec: () => Promise<unknown[]>;
  length: number;
}

/**
 * Redis client interface supporting both real @upstash/redis and graceful fallback mock
 */
export interface RedisClient {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: RedisValue, options?: RedisSetOptions) => Promise<string | null | "OK">;
  del: (...keys: string[]) => Promise<number>;
  hget: (key: string, field: string) => Promise<string | null>;
  hset: (key: string, fields: Record<string, RedisHashFieldValue>) => Promise<number>;
  hsetnx: (key: string, field: string, value: string) => Promise<number>;
  hdel: (key: string, ...fields: string[]) => Promise<number>;
  hgetall: (key: string) => Promise<Record<string, string> | null>;
  hmget: (key: string, ...fields: string[]) => Promise<(string | null)[]>;
  hlen: (key: string) => Promise<number>;
  httl: (key: string) => Promise<number>;
  llen: (key: string) => Promise<number>;
  lpush: (key: string, ...elements: RedisValue[]) => Promise<number>;
  rpush: (key: string, ...elements: RedisValue[]) => Promise<number>;
  zrange: (key: string, start: number, stop: number, options?: RedisZRangeOptions) => Promise<string[]>;
  zadd: (key: string, ...args: (string | number | { score: number; member: string })[]) => Promise<number>;
  zrem: (key: string, ...members: string[]) => Promise<number>;
  zcard: (key: string) => Promise<number>;
  zremrangebyscore: (key: string, min: number | string, max: number | string) => Promise<number>;
  zremrangebyrank: (key: string, start: number, stop: number) => Promise<number>;
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
  ttl: (key: string) => Promise<number>;
  exists: (...keys: string[]) => Promise<number>;
  scan: (cursor: number | string, options?: RedisScanOptions) => Promise<[string, string[]]>;
  mget: (...keys: string[]) => Promise<(string | null)[]>;
  lrange: (key: string, start: number, stop: number) => Promise<string[]>;
  lpop: (key: string, count?: number) => Promise<string | string[] | null>;
  eval: (script: string, keys: string[], args: RedisValue[]) => Promise<unknown>;
  ping: () => Promise<string>;
  pipeline: () => RedisPipeline;
  lrem: (key: string, count: number, element: string) => Promise<number>;
  lmove: (source: string, destination: string, from: "LEFT" | "RIGHT", to: "LEFT" | "RIGHT") => Promise<string | null>;
  ltrim: (key: string, start: number, stop: number) => Promise<string>;
  smembers: (key: string) => Promise<string[]>;
  sismember: (key: string, member: string) => Promise<number>;
  sadd: (key: string, ...members: RedisValue[]) => Promise<number>;
  saddAsync?: (key: string, ...members: RedisValue[]) => Promise<number>;
  srem: (key: string, ...members: RedisValue[]) => Promise<number>;
  zincrby: (key: string, increment: number, member: string) => Promise<number>;
  hscan: (key: string, cursor: number | string, options?: RedisScanOptions) => Promise<[string, string[]]>;
  type: (key: string) => Promise<string>;
  hexpire: (key: string, seconds: number, mode: "NX" | "XX" | "GT" | "LT" | "FIELDS", fieldCount: number, ...fields: string[]) => Promise<number[]>;
  hpexpire: (key: string, milliseconds: number, mode: "NX" | "XX" | "GT" | "LT" | "FIELDS", fieldCount: number, ...fields: string[]) => Promise<number[]>;
}
