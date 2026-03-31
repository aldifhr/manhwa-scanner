import { waitUntil } from "@vercel/functions";
import { InteractionResponseType } from "discord-interactions";
import { resolveWhitelistQuery } from "../services/whitelist.js";
import { loadWhitelist, redis } from "../redis.js";
import { editInteractionResponse } from "../discord.js";
import { sourceLabel, normalizeSourceUrl } from "../domain/source.js";
import { searchIkiru, searchShngm } from "../scraper.js";
import { normalizeTitleKey } from "../domain/manga.js";

async function executeSearch(payload, input) {
  try {
    const items = await loadWhitelist();
    const result = resolveWhitelistQuery(items, input);

    // Prepare global search concurrently
    const globalSearchPromise = Promise.allSettled([
      searchIkiru(input, {}, redis),
      searchShngm(input),
    ]);

    let whitelistEmbed = null;
    let whitelistText = null;

    if (result.status === "matched") {
      const { item } = result;
      const sourcesText = item.sources
        .map(s => {
          const markText = s.mark ? ` \`(${s.mark})\`` : "";
          return `• [${sourceLabel(s.source)}](${s.url})${markText}`;
        })
        .join("\n");

      whitelistEmbed = {
        title: result.suggested ? `💡 Saran Whitelist: ${item.title}` : `🔍 Whitelist: ${item.title}`,
        description: result.suggested 
          ? `Manga **"${input}"** tidak ditemukan, tapi ada hasil serupa di whitelist:\n\n${sourcesText}`
          : `Manga ini sudah terdaftar di whitelist dengan sumber berikut:\n\n${sourcesText}`,
        color: result.suggested ? 0xf1c40f : 0x3498db,
      };
    } else if (result.status === "ambiguous") {
      const lines = result.matches.slice(0, 5).map(({ item, index }) => {
        const sources = (item.sources || []).map(s => `[${sourceLabel(s.source)}]`).join(" ");
        return `${index + 1}. ${item.title} ${sources}`;
      });
      
      const prefix = result.suggested 
        ? `Manga **"${input}"** tidak ditemukan di whitelist. Mungkin maksud kamu:`
        : `Ditemukan beberapa hasil di **Whitelist**:`;
        
      whitelistText = `${prefix}\n${lines.join("\n")}${result.matches.length > 5 ? `\n...dan ${result.matches.length - 5} lainnya.` : ""}`;
    }

    // Wait for global results
    const globalRaw = await globalSearchPromise;
    const globalItems = globalRaw
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value || []);

    // Deduplicate global vs whitelist
    const whitelistUrls = new Set(
      items.flatMap(i => (i.sources || []).map(s => normalizeSourceUrl(s.url || "")))
    );
    const whitelistTitles = new Set(
      items.map(i => normalizeTitleKey(i.title))
    );

    const filteredGlobal = globalItems.filter(gi => {
      const gUrl = normalizeSourceUrl(gi.url || "");
      const gTitle = normalizeTitleKey(gi.title || "");
      return !whitelistUrls.has(gUrl) && !whitelistTitles.has(gTitle);
    });

    // Build Final Response
    const embeds = [];
    if (whitelistEmbed) embeds.push(whitelistEmbed);

    let content = whitelistText || "";
    if (filteredGlobal.length > 0) {
      const globalLines = filteredGlobal.slice(0, 8).map((gi, i) => {
        return `${i + 1}. **${gi.title}** [${sourceLabel(gi.source)}] - [Link](${gi.url})`;
      });
      
      const globalSection = `\n\n### 🌐 Hasil Global (Ikiru/Shinigami)\n${globalLines.join("\n")}${filteredGlobal.length > 8 ? `\n_...dan ${filteredGlobal.length - 8} lainnya._` : ""}`;
      content += globalSection;
      content += `\n\n💡 Gunakan \`/add url:<link>\` untuk menambahkan manga di atas ke whitelist.`;
    }

    if (!whitelistEmbed && !whitelistText && filteredGlobal.length === 0) {
      await editInteractionResponse(payload, `Manga **"${input}"** tidak ditemukan di whitelist maupun database global.`);
      return;
    }

    await editInteractionResponse(payload, { content: content.trim(), embeds });
  } catch (err) {
    console.error("[handleSearch] Error:", err);
    await editInteractionResponse(payload, `Terjadi kesalahan saat mencari: ${err.message}`);
  }
}

export default function handleSearch(payload, options, res) {
  const input = String(options?.[0]?.value || "").trim();
  if (!input) {
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Silakan masukkan judul atau URL manga yang ingin dicari!", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(executeSearch(payload, input));
}
