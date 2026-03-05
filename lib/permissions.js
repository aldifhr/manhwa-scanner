export function isOwner(payload) {
  if (!process.env.DISCORD_OWNER_ID) {
    console.warn("[isOwner] DISCORD_OWNER_ID tidak di-set");
    return false;
  }
  const userId = payload.member?.user?.id ?? payload.user?.id;
  return userId === process.env.DISCORD_OWNER_ID;
}

export function matchTitle(itemTitle, searchTitle) {
  if (!itemTitle || !searchTitle) return false;
  const a = itemTitle.toLowerCase();
  const b = searchTitle.toLowerCase();
  return a.includes(b) || b.includes(a);
}
