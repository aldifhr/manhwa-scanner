import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { searchIkiru } from "../scrapers/ikiru.js";
import { searchShngm } from "../scrapers/secondary.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { normalizeSource, sourceLabel } from "../domain.js";
import { addWhitelistEntry } from "../services/whitelist.js";
import { ensureAddAllowedResponse } from "../permissions.js";
import { resolveAddFromUrl } from "../services/addFromUrl.js";
import {
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_COMPONENT_TYPE,
} from "../config.js";
import { getLogger } from "../logger.js";

const logger = getLogger({ scope: "commands:add" });

const ADD_RESULTS_TTL = 300; // 5 minutes

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

function createSessionId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Search both sources and combine results (no extra timeout - let scrapers handle their own)
async function searchCombined(query, redis, options = {}) {
  const { autocomplete = false } = options;

  const [ikiruResult, shngmResult] = await Promise.allSettled([
    searchIkiru(query, {}, redis).catch(err => {
      logger.warn({ err: err.message }, "[searchCombined] Ikiru search failed");
      return [];
    }),
    searchShngm(query, "shinigami_project").catch(err => {
      logger.warn({ err: err.message }, "[searchCombined] Shngm search failed");
      return [];
    }),
  ]);

  const ikiruItems = ikiruResult.status === "fulfilled"
    ? ikiruResult.value.map(item => ({ ...item, source: "ikiru" }))
    : [];

  const shngmItems = shngmResult.status === "fulfilled"
    ? shngmResult.value.map(item => ({ ...item, source: item.source || "shinigami_project" }))
    : [];

  // Combine and dedupe by title
  const seen = new Set();
  const combined = [...ikiruItems, ...shngmItems].filter(item => {
    const key = `${item.title.toLowerCase().trim()}_${item.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return combined.slice(0, 10); // Max 10 results
}

// Build select menu with numbered options
// FIX: pakai ":" sebagai separator antara sessionId dan index,
// karena sessionId sendiri mengandung "_" sehingga split("_") akan berantakan
function buildResultSelect(sessionId, results) {
  const options = results.map((item, index) => {
    const srcLabel = sourceLabel(item.source);
    const title = item.title.length > 70
      ? `${item.title.substring(0, 67)}...`
      : item.title;

    return {
      label: `${index + 1}. ${title}`,
      value: `${sessionId}:${index}`, // ":" bukan "_"
      description: `${srcLabel}${item.chapter ? ` • ${item.chapter}` : ""}`,
    };
  });

  return [
    {
      type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: DISCORD_COMPONENT_TYPE.STRING_SELECT,
          custom_id: "add_select_result",
          placeholder: "Pilih manga untuk ditambahkan...",
          options,
        },
      ],
    },
  ];
}

// Handle URL add
async function handleUrlAdd(payload, url, redis) {
  try {
    const { title, source, error } = await resolveAddFromUrl(url);
    if (error) {
      return editInteractionResponse(payload, `❌ ${error}`);
    }

    const result = await addWhitelistEntry({ title, url, source });

    if (result.status === "exists") {
      return editInteractionResponse(
        payload,
        `⚠️ **${title}** sudah ada di whitelist (sumber: ${sourceLabel(source)}).`,
      );
    }

    return editInteractionResponse(
      payload,
      `✅ **${title}** berhasil ditambahkan!\n📊 Total manga di whitelist: **${result.whitelist.length}**`,
    );
  } catch (err) {
    logger.error({ err }, "[handleUrlAdd] Error");
    return editInteractionResponse(payload, `❌ Gagal: ${err.message}`);
  }
}

// Handle search and show results
async function handleSearchAdd(payload, query, redis) {
  try {
    await editInteractionResponse(payload, `🔍 Mencari "${query}" di semua sumber...`);

    const results = await searchCombined(query, redis);

    if (!results.length) {
      return editInteractionResponse(
        payload,
        `❌ Tidak ada hasil untuk "${query}".`,
      );
    }

    // Cache results
    const sessionId = createSessionId();
    await redis?.set(`add:results:${sessionId}`, results, { ex: ADD_RESULTS_TTL });

    const content = [
      `📚 **${results.length} hasil** untuk "${query}":`,
      "",
      ...results.map((item, i) =>
        `${i + 1}. **${item.title}** [${sourceLabel(item.source)}]`,
      ),
      "",
      "Pilih manga dari dropdown di bawah:",
    ].join("\n");

    const components = buildResultSelect(sessionId, results);

    return editInteractionResponseWithComponents(payload, content, components, []);
  } catch (err) {
    logger.error({ err }, "[handleSearchAdd] Error");
    return editInteractionResponse(payload, `❌ Error: ${err.message}`);
  }
}

// Handle result selection
// FIX: pakai lastIndexOf(":") + substring agar sessionId yang mengandung "_"
// tidak ikut terpotong saat parsing
export async function handleAddSelection(payload, rawValue, redis) {
  try {
    const separatorIndex = rawValue.lastIndexOf(":");
    if (separatorIndex === -1) {
      return editInteractionResponse(payload, "❌ Format selection tidak valid.");
    }

    const sessionId = rawValue.substring(0, separatorIndex);
    const index = parseInt(rawValue.substring(separatorIndex + 1), 10);

    if (isNaN(index)) {
      return editInteractionResponse(payload, "❌ Format selection tidak valid.");
    }

    const cached = await redis?.get(`add:results:${sessionId}`);
    if (!cached || !Array.isArray(cached) || index < 0 || index >= cached.length) {
      return editInteractionResponse(
        payload,
        "❌ Session expired. Silakan jalankan `/add` lagi.",
      );
    }

    const item = cached[index];
    const result = await addWhitelistEntry({
      title: item.title,
      url: item.mangaUrl || item.url,
      source: item.source,
    });

    if (result.status === "exists") {
      return editInteractionResponse(
        payload,
        `⚠️ **${item.title}** sudah ada di whitelist!`,
      );
    }

    return editInteractionResponse(
      payload,
      `✅ **${item.title}** [${sourceLabel(item.source)}] berhasil ditambahkan!\n📊 Total: **${result.whitelist.length}** manga`,
    );
  } catch (err) {
    logger.error({ err }, "[handleAddSelection] Error");
    return editInteractionResponse(payload, `❌ Error: ${err.message}`);
  }
}

// Autocomplete handler
export async function buildAddAutocomplete(options, redis) {
  // Handle nested options in subcommands
  const subcommand = options?.[0];
  const subOptions = subcommand?.options || [];
  const focused = subOptions.find((item) => item.focused);
  const query = String(focused?.value ?? "").trim();

  if (query.length < 2) return [];

  // If focused is not 'query', don't search
  if (focused?.name !== "query") return [];

  try {
    const results = await searchCombined(query, redis, { autocomplete: true });

    return results.slice(0, 10).map((item) => ({
      name: `${item.title} [${sourceLabel(item.source)}]`.slice(0, 100),
      value: (item.mangaUrl || item.url || item.title).slice(0, 100),
    }));
  } catch (err) {
    logger.warn({ err: err.message }, "[buildAddAutocomplete] Failed, returning empty");
    return [];
  }
}

// Main handler
export default async function handleAdd(payload, options, res, redis = null) {
  // Permission check
  const denied = await ensureAddAllowedResponse(payload, redis);
  if (denied) return res.json(denied);

  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  if (subcommand === "url") {
    const url = String(getOption(subOptions, "url") ?? "").trim();
    if (!url) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "URL tidak boleh kosong.", flags: DISCORD_EPHEMERAL_FLAG },
      });
    }
    res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DISCORD_EPHEMERAL_FLAG },
    });
    waitUntil(handleUrlAdd(payload, url, redis));
    return;
  }

  // Fallback / search subcommand
  const query = String(getOption(subOptions, "query") ?? "").trim();
  if (!query) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Silakan masukkan judul manga yang ingin dicari.",
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }

  res.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: DISCORD_EPHEMERAL_FLAG },
  });
  waitUntil(handleSearchAdd(payload, query, redis));
}
