export function isOwner(payload) {
  if (!process.env.DISCORD_OWNER_ID) {
    console.warn("[isOwner] DISCORD_OWNER_ID tidak di-set");
    return false;
  }
  const userId = payload.member?.user?.id ?? payload.user?.id;
  return userId === process.env.DISCORD_OWNER_ID;
}

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;
const ADD_ALLOWED_USER_IDS = new Set([
  "451393015798300683",
  "536168856339611648",
  "758889693235904522",
]);

export function isGuildAdmin(payload) {
  const raw = payload?.member?.permissions;
  if (raw === undefined || raw === null) return false;

  try {
    const permissions = BigInt(raw);
    return (permissions & ADMINISTRATOR) === ADMINISTRATOR ||
      (permissions & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

export function ensureGuildAdminResponse(payload) {
  if (isGuildAdmin(payload)) return null;
  return {
    type: 4,
    data: {
      content: "Command ini hanya untuk admin server.",
      flags: 64,
    },
  };
}

export async function isAddAllowedUser(payload, redis = null) {
  const userId = String(payload?.member?.user?.id ?? payload?.user?.id ?? "").trim();
  if (!userId) return false;
  if (ADD_ALLOWED_USER_IDS.has(userId)) return true;

  if (redis) {
    try {
      const isAllowed = await redis.sismember("whitelist:allowed_users", userId);
      if (isAllowed) return true;
    } catch (err) {
      console.warn("[isAddAllowedUser] Redis check failed:", err.message);
    }
  }

  return false;
}

export async function ensureAddAllowedResponse(payload, redis = null) {
  if (await isAddAllowedUser(payload, redis)) return null;
  return {
    type: 4,
    data: {
      content: "Command `/add` hanya diizinkan untuk user tertentu.",
      flags: 64,
    },
  };
}


export function matchTitle(itemTitle, searchTitle) {
  if (!itemTitle || !searchTitle) return false;
  const a = itemTitle.toLowerCase();
  const b = searchTitle.toLowerCase();
  return a.includes(b) || b.includes(a);
}
