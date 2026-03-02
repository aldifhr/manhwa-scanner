import { verifyKey, InteractionType } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { loadWhitelist, saveWhitelist } from "../lib/redis.js";
import { editInteractionResponse } from "../lib/discord.js";
import commands from "../lib/commands/index.js";
import handleSearchPage from "../lib/commands/searchPage.js";
import { redis } from "../lib/redis.js";

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleAddManga(payload, title, url = null) {
  try {
    const whitelist = await loadWhitelist();

    const exists = whitelist.some(
      (item) =>
        (typeof item === "string"
          ? item
          : item.title?.toLowerCase() || item.url
        )?.toLowerCase() === title.toLowerCase() || item?.url === url,
    );

    if (exists) {
      await editInteractionResponse(
        payload.token,
        `⚠️ **"${title}"** sudah ada!`,
      );
      return;
    }

    const entry = url ? { title, url } : title;
    whitelist.push(entry);
    await saveWhitelist(whitelist);

    await editInteractionResponse(
      payload.token,
      `✅ **"${title}"** ditambahkan!\n📋 Total: **${whitelist.length}** manga`,
    );
  } catch (err) {
    await editInteractionResponse(payload.token, `❌ ${err.message}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const raw = await getRawBody(req);

  const isValid = await verifyKey(
    raw.toString(),
    sig,
    ts,
    process.env.DISCORD_PUBLIC_KEY,
  );
  if (!isValid) return res.status(401).end();

  const payload = JSON.parse(raw.toString());
  const { type, data: interactionData } = payload;

  if (type === 1) return res.json({ type: 1 });

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id } = interactionData;
    console.log("component custom_id:", custom_id); // ← tambah ini

    if (custom_id === "select_add") {
      const [keyword, idx] = interactionData.values[0].split("|||");
      const cached = await redis.get(`search:results:${keyword}`);
      if (!cached) {
        return res.json({
          type: 4,
          data: {
            content: "⚠️ Session expired, coba `/search` lagi.",
            flags: 64,
          },
        });
      }
      const results = typeof cached === "string" ? JSON.parse(cached) : cached;
      const { title, url } = results[parseInt(idx)];
      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(handleAddManga(payload, title, url));
    }

    if (custom_id.startsWith("search:")) {
      const [, keyword, page = "1"] = custom_id.split(":");
      res.json({ type: 6 });
      return waitUntil(handleSearchPage(payload, keyword, +page, redis));
    }

    if (custom_id.startsWith("add:")) {
      const title = custom_id.replace("add:", "");
      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(handleAddManga(payload, title));
    }

    if (custom_id.startsWith("list:")) {
      const page = parseInt(custom_id.split(":")[1]) || 1;

      // Ambil data dulu sebelum respond ke Discord
      const whitelist = await loadWhitelist();
      const pageSize = 15;
      const totalPage = Math.ceil(whitelist.length / pageSize);
      const safePage = Math.min(Math.max(1, page), totalPage || 1);
      const start = (safePage - 1) * pageSize;
      const slice = whitelist.slice(start, start + pageSize);

      const content =
        `📋 **Whitelist** (${whitelist.length} manga)\n` +
        `*Page ${safePage}/${totalPage}*\n\n` +
        slice.map((item, i) => `${start + i + 1}. ${item.title}`).join("\n");

      const components = [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "◀ Prev",
              custom_id: `list:${safePage - 1}`,
              disabled: safePage <= 1,
            },
            {
              type: 2,
              style: 2,
              label: `Page ${safePage}`,
              custom_id: "noop",
              disabled: true,
            },
            {
              type: 2,
              style: 1,
              label: "Next ▶",
              custom_id: `list:${safePage + 1}`,
              disabled: safePage >= totalPage,
            },
          ],
        },
      ];

      // ✅ Langsung respond dengan data, tidak perlu deferred
      return res.json({
        type: 7, // update message langsung
        data: { content, components, flags: 64 },
      });
    }
  }

  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interactionData;
    const handle = commands[name];

    const commandsWithRes = [
      "search",
      "remove",
      "setchannel",
      "recent",
      "info",
      "list",
      "add",
    ];

    if (commandsWithRes.includes(name)) {
      return handle?.(payload, options, res, redis);
    }

    res.json({ type: 5, data: { flags: 64 } });
    return waitUntil(handle?.(payload, options));
  }

  res.status(400).json({ error: "Unknown interaction" });
}
