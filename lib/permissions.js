export function isOwner(payload) {
  const userId = payload.member?.user?.id || payload.user?.id;
  return userId === process.env.DISCORD_OWNER_ID;
}

export function matchTitle(itemTitle, searchTitle) {
  return (
    itemTitle.toLowerCase().includes(searchTitle.toLowerCase()) ||
    searchTitle.toLowerCase().includes(itemTitle.toLowerCase())
  );
}
