// ─── search-page.js ───────────────────────────────────────────────────────────
import { editInteractionResponseWithComponents  }    from "../discord.js";
import { searchIkiru }           from "../scraper.js";
import { buildSearchEmbed,
         buildSearchComponents } from "./search.js";

export default async function handleSearchPage(payload, keyword, page, redis = null) {
  try {
    // searchIkiru otomatis pakai Redis cache kalau ada —
    // klik Next/Prev tidak akan re-fetch dari server
    const results = await searchIkiru(keyword, {}, redis);

    if (!results || results.length === 0) {
      await editWithComponents(
        payload,
        `🔍 Tidak ada manga dengan keyword **"${keyword}"**.`,
        []
      );
      return;
    }

    const perPage   = 10;
    const total     = results.length;
    const totalPage = Math.ceil(total / perPage);
    const safePage  = Math.max(1, Math.min(page, totalPage));
    const slice     = results.slice((safePage - 1) * perPage, safePage * perPage);

    const embed      = buildSearchEmbed(keyword, slice, safePage, totalPage, total);
    const components = buildSearchComponents(keyword, slice, safePage, totalPage);

    await editInteractionResponseWithComponents(payload, "", components, [embed]);
  } catch (err) {
    console.error("handleSearchPage error:", err);
    await editInteractionResponseWithComponents(payload, `❌ Error: ${err.message}`, []);
  }
}