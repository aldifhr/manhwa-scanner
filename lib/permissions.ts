import { InteractionResponseType } from "discord-interactions";
import { getLogger } from "./logger.js";
import { DISCORD_EPHEMERAL_FLAG } from "./config.js";
import { RedisClient } from "./types.js";
import { env } from "./config/env.js";

const logger = getLogger({ scope: "permissions" });

export function isOwner(payload: any): boolean {
  if (!env.DISCORD_OWNER_ID) {
    logger.warn("DISCORD_OWNER_ID tidak di-set");
    return false;
  }
  const userId = payload.member?.user?.id ?? payload.user?.id;
  return userId === env.DISCORD_OWNER_ID;
}

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;
export const ADD_ALLOWED_USER_IDS = new Set([
  "451393015798300683",
  "536168856339611648",
  "758889693235904522",
  ...(env.ALLOWED_USER_IDS
    ? (env.ALLOWED_USER_IDS as string).split(",").map((id: string) => id.trim()).filter(Boolean)
    : []),
]);

export function isGuildAdmin(payload: any): boolean {
  const raw = payload?.member?.permissions;
  if (raw === undefined || raw === null) return false;

  try {
    const permissions = BigInt(raw);
    return (
      (permissions & ADMINISTRATOR) === ADMINISTRATOR ||
      (permissions & MANAGE_GUILD) === MANAGE_GUILD
    );
  } catch {
    return false;
  }
}

export function ensureGuildAdminResponse(payload: any) {
  if (isGuildAdmin(payload)) return null;
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: "Command ini hanya untuk admin server.",
      flags: DISCORD_EPHEMERAL_FLAG,
    },
  };
}

export async function isAddAllowedUser(payload: any, redis: RedisClient | null = null): Promise<boolean> {
  // 1. Bot Owner is always allowed
  if (isOwner(payload)) return true;
  
  // 2. Server Admins are always allowed
  if (isGuildAdmin(payload)) return true;

  const userId = payload.member?.user?.id ?? payload.user?.id;

  // 3. Hardcoded allowlist (always effective regardless of Redis)
  if (userId && ADD_ALLOWED_USER_IDS.has(userId)) return true;
  
  // 4. Check Redis dynamic whitelist
  if (redis && userId) {
    try {
      const isAllowed = await redis.sismember("whitelist:allowed_users", userId);
      return !!isAllowed;
    } catch (err) {
      logger.error({ err }, "Failed to check permission in Redis");
    }
  }

  // 5. Open access: allow everyone when no Redis is provided
  if (!redis) return true;

  return false;
}




