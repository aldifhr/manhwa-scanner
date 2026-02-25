import { verifyKey } from "discord-interactions";
import fs from "fs";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

// Command definitions
const COMMANDS = {
  ADD: {
    name: "add",
    description: "Add manga to whitelist",
    options: [{
      name: "title",
      description: "Manga title",
      type: 3, // STRING
      required: true
    }]
  },
  REMOVE: {
    name: "remove",
    description: "Remove manga from whitelist",
    options: [{
      name: "title",
      description: "Manga title",
      type: 3,
      required: true
    }]
  },
  LIST: {
    name: "list",
    description: "Show all whitelisted manga"
  },
  STATUS: {
    name: "status",
    description: "Check bot status"
  }
};

function loadWhitelist() {
  try {
    const data = JSON.parse(fs.readFileSync("./whitelist.json", "utf-8"));
    return data.manga;
  } catch {
    return [];
  }
}

function saveWhitelist(manga) {
  fs.writeFileSync("./whitelist.json", JSON.stringify({ manga }, null, 2));
}

async function registerCommands() {
  try {
    const response = await fetch(`https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`, {
      method: "PUT",
      headers: {
        "Authorization": `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(Object.values(COMMANDS))
    });
    
    if (response.ok) {
      console.log("✅ Commands registered successfully");
    } else {
      console.error("❌ Failed to register commands:", await response.text());
    }
  } catch (err) {
    console.error("❌ Error registering commands:", err.message);
  }
}

function createResponse(content, ephemeral = false) {
  return {
    type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
    data: {
      content,
      flags: ephemeral ? 64 : 0
    }
  };
}

async function handleCommand(command, options) {
  const whitelist = loadWhitelist();
  
  switch (command) {
    case "add": {
      const title = options.find(o => o.name === "title")?.value;
      if (!title) return createResponse("❌ Please provide a manga title", true);
      
      if (whitelist.some(w => w.toLowerCase() === title.toLowerCase())) {
        return createResponse(`⚠️ "${title}" is already in whitelist`, true);
      }
      
      whitelist.push(title);
      saveWhitelist(whitelist);
      return createResponse(`✅ Added "${title}" to whitelist`, true);
    }
    
    case "remove": {
      const title = options.find(o => o.name === "title")?.value;
      if (!title) return createResponse("❌ Please provide a manga title", true);
      
      const index = whitelist.findIndex(w => w.toLowerCase() === title.toLowerCase());
      if (index === -1) {
        return createResponse(`⚠️ "${title}" not found in whitelist`, true);
      }
      
      whitelist.splice(index, 1);
      saveWhitelist(whitelist);
      return createResponse(`✅ Removed "${title}" from whitelist`, true);
    }
    
    case "list": {
      if (whitelist.length === 0) {
        return createResponse("📋 Whitelist is empty");
      }
      
      const list = whitelist.map((m, i) => `${i + 1}. ${m}`).join("\n");
      return createResponse(`📋 **Whitelisted Manga (${whitelist.length}):**\n\n${list}`);
    }
    
    case "status": {
      return createResponse(
        "🤖 **Bot Status**\n\n" +
        "✅ Online and running\n" +
        `📋 Whitelist: ${whitelist.length} manga\n` +
        `⏰ Check interval: Every 5 minutes`
      );
    }
    
    default:
      return createResponse("❌ Unknown command", true);
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Get raw body for signature verification
    const rawBody = await getRawBody(req);
    const body = JSON.parse(rawBody);
    
    // Verify Discord signature
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    
    const isValid = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { type, data } = body;

    // Handle ping (Discord verification)
    if (type === 1) {
      return res.status(200).json({ type: 1 });
    }

    // Handle commands
    if (type === 2) {
      const response = await handleCommand(data.name, data.options || []);
      return res.status(200).json(response);
    }

    return res.status(400).json({ error: "Unknown interaction type" });
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// Register commands on startup
if (process.env.NODE_ENV !== "development") {
  registerCommands();
}
