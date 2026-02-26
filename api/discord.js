import { verifyKey, InteractionType } from "discord-interactions";
import { waitUntil }                  from "@vercel/functions";
import { loadWhitelist, saveWhitelist } from "../lib/redis.js";
import { editInteractionResponse }    from "../lib/discord.js";
import handleSearchPage               from "../lib/commands/searchPage.js";
import commands                       from "../lib/commands/index.js";

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  (c) => chunks.push(c));
    req.on("end",   () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const sig  = req.headers["x-signature-ed25519"];
  const ts   = req.headers["x-signature-timestamp"];
  const raw  = await getRawBody(req);
  const body = raw.toString();

  const isValid = await verifyKey(body, sig, ts, process.env.DISCORD_PUBLIC_KEY);
  if (!isValid) return res.status(401).end();

  const payload = JSON.parse(body);

  if (payload.type === 1) return res.json({ type: 1 });

  const { type, data: interactionData } = payload;

  // ── Button interactions ──
  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id } = interactionData;

    // Pagination search
    if (custom_id.startsWith("search:")) {
      const parts   = custom_id.split(":");
      const keyword = parts[1];
      const page    = parseInt(parts[2]);
      res.json({ type: 6 });
      waitUntil(handleSearchPage(payload, keyword, page));
      return;
    }

    // Add manga via tombol
    if (custom_id.startsWith("add:")) {
      const title = custom_id.replace("add:", "");
      res.json({ type: 5, data: { flags: 64 } });

      waitUntil((async () => {
        try {
          const whitelist = await loadWhitelist();
          if (whitelist.some((t) => t.toLowerCase() === title.toLowerCase())) {
            await editInteractionResponse(payload.token, `⚠️ **"${title}"** sudah ada di whitelist!`);
            return;
          }
          whitelist.push(title);
          await saveWhitelist(whitelist);
          await editInteractionResponse(payload.token,
            `✅ **"${title}"** ditambahkan!\n📋 Total: **${whitelist.length}** manga`
          );
        } catch (err) {
          await editInteractionResponse(payload.token, `❌ Error: ${err.message}`);
        }
      })());
      return;
    }
  }

  // ── Slash commands ──
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interactionData;
    const handle            = commands[name];
    if (handle) return handle(payload, options, res);
  }

  return res.status(400).json({ error: "Unknown interaction" });
}
