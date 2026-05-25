import { readChannelValidationState, writeChannelValidationState } from "../services/storage.js";
import { shouldRunChannelValidation, buildGuildChannelMap } from "./helpers.js";
import type { RedisClient } from "../types.js";

export async function loadValidatedGuilds({
  redisClient,
  guildEntries,
  channelValidationConcurrency,
  botToken,
  log,
  warn,
}: {
  redisClient: RedisClient;
  guildEntries: [string, string][];
  channelValidationConcurrency: number;
  botToken: string;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}) {
  const lastValidationState = (await readChannelValidationState(redisClient)) as
    | { lastRun?: string; at?: string; totalChannels?: number; total?: number; validCount?: number; valid?: number; invalidCount?: number }
    | string
    | null;
  const lastValidationAt =
    typeof lastValidationState === "string"
      ? lastValidationState
      : lastValidationState?.lastRun || lastValidationState?.at || null;
  const runFullValidation = shouldRunChannelValidation(lastValidationAt);

  if (!runFullValidation) {
    return {
      guilds: buildGuildChannelMap(guildEntries),
      lastValidationAt,
      runFullValidation,
    };
  }

  const { validateDiscordChannelsBatch } = await import("../services/channelValidation.js");

  const channelIds = guildEntries.map(([, channelId]) => channelId);
  const validationResults = await validateDiscordChannelsBatch({
    redis: redisClient,
    channelIds,
    botToken,
    cacheSec: 21600,
    concurrency: channelValidationConcurrency,
  });

  const guilds: Record<string, string> = {};
  for (const [guildId, channelId] of guildEntries) {
    if (validationResults.get(channelId)) {
      guilds[guildId] = channelId;
      log(`CONNECTED: guild ${guildId.slice(-4)} ch ${channelId.slice(-4)}`);
    } else {
      warn(`DISCONNECTED: guild ${guildId.slice(-4)} ch ${channelId.slice(-4)}`);
    }
  }

  await writeChannelValidationState(redisClient, {
    lastRun: new Date().toISOString(),
    totalChannels: guildEntries.length,
    validCount: Object.keys(guilds).length,
    invalidCount: guildEntries.length - Object.keys(guilds).length,
  });

  return {
    guilds,
    lastValidationAt,
    runFullValidation,
  };
}
