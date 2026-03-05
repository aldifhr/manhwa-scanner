import { verifyKey, InteractionType } from "discord-interactions";
import { waitUntil }                  from "@vercel/functions";
import { loadWhitelist, saveWhitelist, redis } from "../lib/redis.js";
import { editInteractionResponse }    from "../lib/discord.js";
import commands                       from "../lib/commands/index.js";
import handleSearchPage               from "../lib/commands/searchPage.js";

export const config = { api: { bodyParser: false } };

// ─── RAW BODY ─────────────────────────────────────────────────────────────────

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── ADD MANGA (single source of truth) ──────────────────────────────────────

async function handleAddManga(payload, title, url = null) {
  try {
    const whitelist = await loadWhitelist();

    const exists = whitelist.some(
      (item) =>
        item.title?.toLowerCase() === title.toLowerCase() ||
        (url && item.url === url),
    );

    if (exists) {
      await editInteractionResponse(payload, `⚠️ **"${title}"** sudah ada!`);
      return;
    }

    whitelist.push({ title, url: url ?? null });
    await saveWhitelist(whitelist);

    await editInteractionResponse(
      payload,
      `✅ **"${title}"** ditambahkan!\n📋 Total: **${whitelist.length}** manga`,
    );
  } catch (err) {
    console.error("[handleAddManga] Error:", err);
    await editInteractionResponse(payload, `❌ Error: ${err.message}`);
  }
}

// ─── LIST BUILDER (single source of truth) ───────────────────────────────────

async function buildListResponse(page = 1) {
  const whitelist = await loadWhitelist();
  const pageSize  = 10;
  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage  = Math.min(Math.max(1, page), totalPage);
  const start     = (safePage - 1) * pageSize;
  const slice     = whitelist.slice(start, start + pageSize);

  const content = whitelist.length === 0
    ? "📋 Whitelist kosong!"
    : `📋 **Whitelist** (${whitelist.length} manga)\n` +
      `*Page ${safePage}/${totalPage}*\n\n` +
      slice.map((item, i) => `${start + i + 1}. ${item.title}`).join("\n");

  const components = whitelist.length === 0 ? [] : [
    {
      type: 1,
      components: [
        {
          type:      2,
          style:     1,
          label:     "◀ Prev",
          custom_id: `list:${safePage - 1}`,
          disabled:  safePage <= 1,
        },
        {
          type:      2,
          style:     2,
          label:     `Page ${safePage}`,
          custom_id: "noop",
          disabled:  true,
        },
        {
          type:      2,
          style:     1,
          label:     "Next ▶",
          custom_id: `list:${safePage + 1}`,
          disabled:  safePage >= totalPage,
        },
      ],
    },
  ];

  return { content, components };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
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

  // ── PING ──────────────────────────────────────────────────────────────────
  if (type === 1) return res.json({ type: 1 });

  // ── MESSAGE COMPONENT ─────────────────────────────────────────────────────
  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id } = interactionData;
    console.log("[router] component custom_id:", custom_id);

    // Tambah manga dari hasil search dropdown
    if (custom_id === "select_add") {
      const [keyword, slugOrUrl] = interactionData.values[0].split("|||");

      const cached = await redis.get(`search:results:${keyword}`);
      if (!cached) {
        return res.json({
          type: 4,
          data: { content: "⚠️ Session expired, coba `/search` lagi.", flags: 64 },
        });
      }

      // Upstash auto-deserialize — tidak perlu JSON.parse
      const results = Array.isArray(cached) ? cached : [];
      const item = results.find(
        (r) => (r.slug ?? r.mangaUrl ?? r.url) === slugOrUrl,
      );

      if (!item) {
        return res.json({
          type: 4,
          data: { content: "⚠️ Manga tidak ditemukan, coba `/search` lagi.", flags: 64 },
        });
      }

      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(handleAddManga(payload, item.title, item.mangaUrl ?? item.url));
    }

    // Navigasi halaman search
    if (custom_id.startsWith("search:")) {
      const parts   = custom_id.split(":");
      const keyword = parts[1];
      const page    = parseInt(parts[2], 10) || 1;
      res.json({ type: 6 });
      return waitUntil(handleSearchPage(payload, keyword, page, redis));
    }

    // Tambah manga langsung dari button add
    if (custom_id.startsWith("add:")) {
      const title = custom_id.replace("add:", "");
      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(handleAddManga(payload, title));
    }

    // Navigasi halaman list — update message in-place (type 7)
    if (custom_id.startsWith("list:")) {
      const page = parseInt(custom_id.split(":")[1], 10) || 1;
      const { content, components } = await buildListResponse(page);
      return res.json({ type: 7, data: { content, components, flags: 64 } });
    }

    return res.status(400).json({ error: "Unknown component" });
  }

  // ── APPLICATION COMMAND ───────────────────────────────────────────────────
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interactionData;
    const handle = commands[name];

    if (!handle) {
      console.warn(`[router] Unknown command: ${name}`);
      return res.status(400).json({ error: "Unknown command" });
    }

    // /list — sync, pakai buildListResponse langsung
    if (name === "list") {
      const page = parseInt(options?.[0]?.value, 10) || 1;
      const { content, components } = await buildListResponse(page);
      return res.json({ type: 4, data: { content, components, flags: 64 } });
    }

    // Semua command lain selalu dapat res dan redis
    // ping  → langsung res.json() di dalam handler
    // yang lain → defer sendiri di dalam handler masing-masing
    return handle(payload, options, res, redis);
  }

  res.status(400).json({ error: "Unknown interaction type" });
}