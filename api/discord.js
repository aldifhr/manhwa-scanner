import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
} from "discord-interactions";
import fs from "fs";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

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

  try {
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    
    if (!PUBLIC_KEY) {
      return res.status(401).json({ error: "Public key not configured" });
    }

    const rawBody = await getRawBody(req);
    const body = rawBody.toString();

    // Verify signature FIRST (Discord requires this even for PING)
    console.log("Verifying with public key:", PUBLIC_KEY?.slice(0, 20) + "...");
    const isValid = await verifyKey(body, signature, timestamp, PUBLIC_KEY);
    console.log("Signature valid:", isValid);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(body);

    // Handle PING after verification
    if (payload.type === 1) {
      return res.json({ type: 1 });
    }

    const { type, data: interactionData, member } = payload;

    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interactionData;

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
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
