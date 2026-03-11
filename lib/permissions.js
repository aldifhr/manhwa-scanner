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

export function matchTitle(itemTitle, searchTitle) {
  if (!itemTitle || !searchTitle) return false;
  const a = itemTitle.toLowerCase();
  const b = searchTitle.toLowerCase();
  return a.includes(b) || b.includes(a);
}
