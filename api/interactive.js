import { verifyKey, InteractionType } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { loadWhitelist, saveWhitelist, redis } from "../lib/redis.js";
import { editInteractionResponse } from "../lib/discord.js";
import commands from "../lib/commands/index.js";
import handleSearchPage from "../lib/commands/searchPage.js";
import { logApiHit } from "../lib/requestLog.js";

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizeSource(source = "") {
  const s = String(source).toLowerCase().trim();
  if (s === "mirror" || s === "shinigami_mirror") return "shinigami_mirror";
  if (s === "shinigami" || s === "project" || s === "shinigami_project") {
    return "shinigami_project";
  }
  return "ikiru";
}

function sourceLabel(source = "") {
  const s = normalizeSource(source);
  if (s === "shinigami_project") return "Shinigami (Project)";
  if (s === "shinigami_mirror") return "Shinigami (Mirror)";
  return "Ikiru";
}

async function handleAddManga(payload, title, url = null, source = "ikiru") {
  try {
    const normalizedSource = normalizeSource(source);
    const whitelist = await loadWhitelist();

    const exists = whitelist.some(
      (item) =>
        normalizeSource(item.source) === normalizedSource &&
        (item.title?.toLowerCase() === title.toLowerCase() || (url && item.url === url)),
    );

    if (exists) {
      await editInteractionResponse(
        payload,
        `**${title}** already exists in **${sourceLabel(normalizedSource)}**.`,
      );
      return;
    }

    whitelist.push({ title, url: url ?? null, source: normalizedSource });
    await saveWhitelist(whitelist);

    await editInteractionResponse(
      payload,
      `Added **${title}** from **${sourceLabel(normalizedSource)}**.\nTotal: **${whitelist.length}**`,
    );
  } catch (err) {
    console.error("[handleAddManga] Error:", err);
    await editInteractionResponse(payload, `Error: ${err.message}`);
  }
}

async function buildListResponse(page = 1) {
  const whitelist = await loadWhitelist();
  const pageSize = 10;
  const totalPage = Math.ceil(whitelist.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page), totalPage);
  const start = (safePage - 1) * pageSize;
  const slice = whitelist.slice(start, start + pageSize);

  const content =
    whitelist.length === 0
      ? "Whitelist empty."
      : `Whitelist (${whitelist.length})\nPage ${safePage}/${totalPage}\n\n` +
        slice
          .map(
            (item, i) =>
              `${start + i + 1}. [${sourceLabel(item.source)}] ${item.title}`,
          )
          .join("\n");

  const components =
    whitelist.length === 0
      ? []
      : [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Prev",
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
                label: "Next",
                custom_id: `list:${safePage + 1}`,
                disabled: safePage >= totalPage,
              },
            ],
          },
        ];

  return { content, components };
}

export default async function handler(req, res) {
  logApiHit("interactive", req);

  if (req.method !== "POST") return res.status(405).end();

  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const raw = await getRawBody(req);
  const rawString = raw.toString();

  const isValid = await verifyKey(
    rawString,
    sig,
    ts,
    process.env.DISCORD_PUBLIC_KEY,
  );
  if (!isValid) return res.status(401).end();

  const payload = JSON.parse(rawString);
  const { type, data: interactionData } = payload;

  if (type === 1) return res.json({ type: 1 });

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id } = interactionData;

    if (custom_id === "select_add") {
      const [rawSource, keyword, id] = String(interactionData.values?.[0] || "").split("|||");
      const source = normalizeSource(rawSource);
      const cached =
        (await redis.get(`search:results:${source}:${keyword}`)) ||
        (await redis.get(`search:results:${keyword}`));

      if (!cached) {
        return res.json({
          type: 4,
          data: { content: "Session expired. Run /search again.", flags: 64 },
        });
      }

      const results = Array.isArray(cached) ? cached : [];
      const item = results.find((r) => (r.slug ?? r.mangaUrl ?? r.url) === id);

      if (!item) {
        return res.json({
          type: 4,
          data: { content: "Selected manga not found. Run /search again.", flags: 64 },
        });
      }

      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(
        handleAddManga(
          payload,
          item.title,
          item.mangaUrl ?? item.url,
          item.source ?? source,
        ),
      );
    }

    if (custom_id === "select_add_src") {
      const [rawSource, keyword, id] = String(interactionData.values?.[0] || "").split("|||");
      const source = normalizeSource(rawSource);
      const cached = await redis.get(`add:results:${source}:${keyword}`);

      if (!cached) {
        return res.json({
          type: 4,
          data: { content: "Session expired. Run /add again.", flags: 64 },
        });
      }

      const results = Array.isArray(cached) ? cached : [];
      const item = results.find((r) => (r.slug ?? r.mangaUrl ?? r.url) === id);

      if (!item) {
        return res.json({
          type: 4,
          data: { content: "Selected manga not found. Run /add again.", flags: 64 },
        });
      }

      res.json({ type: 5, data: { flags: 64 } });
      return waitUntil(
        handleAddManga(
          payload,
          item.title,
          item.mangaUrl ?? item.url,
          item.source ?? source,
        ),
      );
    }

    if (custom_id.startsWith("search:")) {
      const parts = custom_id.split(":");
      const page = parseInt(parts.pop(), 10) || 1;
      const source = normalizeSource(parts[1] || "all");
      const keyword = decodeURIComponent(parts.slice(2).join(":"));
      res.json({ type: 6 });
      return waitUntil(handleSearchPage(payload, keyword, page, source, redis));
    }

    if (custom_id.startsWith("list:")) {
      const page = parseInt(custom_id.split(":")[1], 10) || 1;
      const { content, components } = await buildListResponse(page);
      return res.json({ type: 7, data: { content, components, flags: 64 } });
    }

    return res.status(400).json({ error: "Unknown component" });
  }

  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interactionData;
    const handle = commands[name];

    if (!handle) {
      return res.status(400).json({ error: "Unknown command" });
    }

    if (name === "list") {
      const page = parseInt(options?.[0]?.value, 10) || 1;
      const { content, components } = await buildListResponse(page);
      return res.json({ type: 4, data: { content, components, flags: 64 } });
    }

    return handle(payload, options, res, redis);
  }

  res.status(400).json({ error: "Unknown interaction type" });
}
