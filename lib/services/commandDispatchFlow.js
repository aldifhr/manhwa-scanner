import { createWhitelistMatcher } from "../domain/manga.js";
import { getAllGuildChannels, loadWhitelist } from "../redis.js";

export async function loadMatchedDispatchContext({
  scrapeUpdates,
  prioritizeChannels = false,
} = {}) {
  if (typeof scrapeUpdates !== "function") {
    throw new Error("loadMatchedDispatchContext requires scrapeUpdates");
  }

  const [whitelist, allResults, guildChannels] = await Promise.all([
    loadWhitelist(),
    scrapeUpdates(),
    getAllGuildChannels(),
  ]);

  const channelIds = Object.values(guildChannels || {});
  if (prioritizeChannels && !channelIds.length) {
    return {
      status: "no_channels",
      whitelist,
      allResults,
      guildChannels,
      channelIds,
      matched: [],
    };
  }

  if (!whitelist.length) {
    return {
      status: "empty_whitelist",
      whitelist,
      allResults,
      guildChannels,
      channelIds,
      matched: [],
    };
  }

  if (!channelIds.length) {
    return {
      status: "no_channels",
      whitelist,
      allResults,
      guildChannels,
      channelIds,
      matched: [],
    };
  }

  const isMatched = createWhitelistMatcher(whitelist);
  const matched = allResults.filter(isMatched);
  if (!matched.length) {
    return {
      status: "no_matches",
      whitelist,
      allResults,
      guildChannels,
      channelIds,
      matched,
    };
  }

  return {
    status: "ok",
    whitelist,
    allResults,
    guildChannels,
    channelIds,
    matched,
  };
}
