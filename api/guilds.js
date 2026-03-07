import { getAllGuildChannels } from "../lib/redis.js";
import { isCronAuthorized } from "../lib/auth.js";
import { logApiHit } from "../lib/requestLog.js";
import axios from "axios";

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CACHE_TTL_MS = 5 * 60 * 1000;
const metaCache = new Map();

async function fetchGuildMeta(guildId, channelId) {
  const key = `${guildId}:${channelId}`;
  const now = Date.now();
  const cached = metaCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const headers = { Authorization: `Bot ${DISCORD_TOKEN}` };

  let guildName = null;
  let channelName = null;

  try {
    const [guildResp, channelResp] = await Promise.all([
      axios.get(`https://discord.com/api/v10/guilds/${guildId}`, { headers }),
      axios.get(`https://discord.com/api/v10/channels/${channelId}`, { headers }),
    ]);
    guildName = guildResp.data?.name ?? null;
    channelName = channelResp.data?.name ?? null;
  } catch {
    // fallback ke null; frontend tetap akan tampilkan ID
  }

  const value = { guildName, channelName };
  metaCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

export default async function handler(req, res) {
  logApiHit("guilds", req);

  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  if (!isCronAuthorized(req))
    return res.status(401).json({ error: "Unauthorized" });

  res.setHeader("Cache-Control", "no-store");
  try {
    const channelMap = await getAllGuildChannels();
    const entries = Object.entries(channelMap);
    const guilds = await Promise.all(
      entries.map(async ([guildId, channelId]) => {
        const safeChannelId = String(channelId);
        const meta = DISCORD_TOKEN
          ? await fetchGuildMeta(guildId, safeChannelId)
          : { guildName: null, channelName: null };

        return {
          guildId,
          channelId: safeChannelId,
          guildName: meta.guildName,
          channelName: meta.channelName,
        };
      }),
    );

    res.json({ guilds });
  } catch (error) {
    console.error("[guilds] Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
