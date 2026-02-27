import { verifyKey, InteractionType } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { loadWhitelist, saveWhitelist } from "../lib/redis.js";
import { editInteractionResponse } from "../lib/discord.js";
import commands from "../lib/commands/index.js";
import handleSearchPage from "../lib/commands/searchPage.js";
import { redis } from "../lib/redis.js";

export const config = { api: { bodyParser: false } };

// Ambil raw body
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Shared logic untuk menambah manga
async function handleAddManga(payload, title, url = null) {
  try {
    const whitelist = await loadWhitelist();

    // Cek duplikat
    const exists = whitelist.some(item => 
      (typeof item === 'string' ? item : item.title?.toLowerCase() || item.url)
        ?.toLowerCase() === title.toLowerCase() ||
      item?.url === url
    );

    if (exists) {
      await editInteractionResponse(payload.token, `⚠️ **"${title}"** sudah ada!`);
      return;
    }

    const entry = url ? { title, url } : title;
    whitelist.push(entry);
    await saveWhitelist(whitelist);

    await editInteractionResponse(
      payload.token,
      `✅ **"${title}"** ditambahkan!\n📋 Total: **${whitelist.length}** manga`
    );
  } catch (err) {
    await editInteractionResponse(payload.token, `❌ ${err.message}`);
  }
}

// Handler utama
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  const raw = await getRawBody(req);

  const isValid = await verifyKey(
    raw.toString(),
    sig,
    ts,
    process.env.DISCORD_PUBLIC_KEY
  );
  if (!isValid) return res.status(401).end();

  const payload = JSON.parse(raw.toString());
  const { type, data: interactionData } = payload;

  // Ping
  if (type === 1) return res.json({ type: 1 });

  // MESSAGE COMPONENTS
  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id } = interactionData;

    // Select menu add
    if (custom_id === "select_add") {
      const [title, url] = interactionData.values[0].split("|||");
      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(handleAddManga(payload, title, url));
    }

    // Search pagination
    if (custom_id.startsWith("search:")) {
      const [, keyword, page = '1'] = custom_id.split(":");
      res.json({ type: 6 });
      return waitUntil(handleSearchPage(payload, keyword, +page, redis));
    }

    // Legacy button add
    if (custom_id.startsWith("add:")) {
      const title = custom_id.replace("add:", "");
      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(handleAddManga(payload, title));
    }

    // **List pagination Next/Prev**
    if (custom_id.startsWith("list:")) {
      const page = parseInt(custom_id.split(":")[1]) || 1;
      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(commands["list"](payload, [{ value: page }], { json: () => {} }));
    }

    // Clear all whitelist
    if (custom_id === "clear_all") {
      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil((async () => {
        try {
          await saveWhitelist([]);
          await editInteractionResponse(payload.token, "🗑️ Whitelist dibersihkan!");
        } catch (err) {
          await editInteractionResponse(payload.token, `❌ ${err.message}`);
        }
      })());
    }
  }

  // SLASH COMMANDS
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interactionData;
    const handle = commands[name];
    return handle?.(payload, options, res);
  }

  res.status(400).json({ error: "Unknown interaction" });
}