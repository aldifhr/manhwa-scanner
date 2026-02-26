import { editWithComponents }             from "../discord.js";
import { searchIkiru }                    from "../scraper.js";
import { buildSearchEmbed,
         buildSearchComponents }          from "./search.js";

export default async function handleSearchPage(payload, keyword, page) {
  try {
    const results   = await searchIkiru(keyword);
    const perPage   = 10;
    const total     = results.length;
    const totalPage = Math.ceil(total / perPage);
    const safePage  = Math.max(1, Math.min(page, totalPage));
    const slice     = results.slice((safePage - 1) * perPage, safePage * perPage);

    const embed      = buildSearchEmbed(keyword, slice, safePage, totalPage, total);
    const components = buildSearchComponents(keyword, slice, safePage, totalPage);

    await editWithComponents(payload, "", components, [embed]);
  } catch (err) {
    await editWithComponents(payload, `❌ Error: ${err.message}`, []);
  }
}
