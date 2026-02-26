import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";
import fs from "fs";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

function loadWhitelist() {
  try {
    const data = JSON.parse(fs.readFileSync("./whitelist.json", "utf-8"));
    return data.manga || [];
  } catch {
    return [];
  }
}

function saveWhitelist(manga) {
  fs.writeFileSync("./whitelist.json", JSON.stringify({ manga }, null, 2));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const body = JSON.stringify(req.body);

  const isValid = verifyKey(body, signature, timestamp, PUBLIC_KEY);
  if (!isValid) {
    return res.status(401).json({ error: "Invalid request signature" });
  }

  const { type, data: interactionData, member } = req.body;

  if (type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interactionData;
    const user = member?.user?.username || "Unknown";

    if (name === "add") {
      const title = options?.[0]?.value;
      if (!title) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "❌ Please provide a manga title!" },
        });
      }

      const whitelist = loadWhitelist();
      if (whitelist.some(t => t.toLowerCase() === title.toLowerCase())) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `⚠️ "${title}" is already in the whitelist!` },
        });
      }

      whitelist.push(title);
      saveWhitelist(whitelist);

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Added "${title}" to the whitelist!\n📋 Total: ${whitelist.length} manga`,
        },
      });
    }

    if (name === "remove") {
      const title = options?.[0]?.value;
      if (!title) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "❌ Please provide a manga title!" },
        });
      }

      const whitelist = loadWhitelist();
      const index = whitelist.findIndex(
        t => t.toLowerCase() === title.toLowerCase()
      );

      if (index === -1) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `⚠️ "${title}" is not in the whitelist!` },
        });
      }

      whitelist.splice(index, 1);
      saveWhitelist(whitelist);

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Removed "${title}" from the whitelist!\n📋 Total: ${whitelist.length} manga`,
        },
      });
    }

    if (name === "list") {
      const whitelist = loadWhitelist();
      if (whitelist.length === 0) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "📋 Whitelist is empty!" },
        });
      }

      const list = whitelist.map((t, i) => `${i + 1}. ${t}`).join("\n");
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `📋 **Whitelisted Manga (${whitelist.length}):**\n\n${list}`,
        },
      });
    }

    if (name === "status") {
      const whitelist = loadWhitelist();
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `📊 **Bot Status**\n\n📋 Whitelisted: ${whitelist.length} manga\n⏱️ Check interval: Every 5 minutes\n🔔 Notifications: Discord + Telegram`,
        },
      });
    }
  }

  return res.status(400).json({ error: "Unknown interaction type" });
}
