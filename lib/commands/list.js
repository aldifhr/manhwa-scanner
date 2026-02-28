export default async function handleList(payload, options, res) {
  const whitelist = await loadWhitelist();

  if (!whitelist.length) {
    return res.json({
      type: 4,
      data: { content: "📋 Whitelist kosong!" }
    });
  }

  const content =
    `📋 **Whitelist** (${whitelist.length} manga)\n\n` +
    whitelist.map((item, i) =>
      `${i + 1}. ${item.title}`
    ).join("\n");

  return res.json({
    type: 4,
    data: { content }
  });
}

// import { loadWhitelist } from "../redis.js";
// import { editInteractionResponse, editWithComponents } from "../discord.js";

// export default async function handleList(
//   payload,
//   options,
//   res,
//   isComponent = false,
// ) {
//   try {
//     if (!isComponent) {
//       res.json({ type: 5 });
//       return; // 🔥 WAJIB
//     }

//     const whitelist = await loadWhitelist(); // ← WAJIB ini
//     console.log("WHITELIST:", whitelist);

//     if (!whitelist.length) {
//       await editInteractionResponse(payload.token, "📋 Whitelist kosong!");
//       return;
//     }

//     const pageSize = 15;
//     const page = Math.max(1, parseInt(options?.[0]?.value) || 1);
//     const totalPage = Math.ceil(whitelist.length / pageSize);

//     const safePage = Math.min(page, totalPage);
//     const start = (safePage - 1) * pageSize;
//     const slice = whitelist.slice(start, start + pageSize);

//     const content =
//       `📋 **Whitelist** (${whitelist.length} manga)\n` +
//       `*Page ${safePage}/${totalPage}*\n\n` +
//       slice.map((item, i) => `${start + i + 1}. ${item.title}`).join("\n");

//     const components = [
//       {
//         type: 1,
//         components: [
//           {
//             type: 2,
//             style: 1,
//             label: "◀ Prev",
//             custom_id: `list:${safePage - 1}`,
//             disabled: safePage <= 1,
//           },
//           {
//             type: 2,
//             style: 2,
//             label: `Page ${safePage}`,
//             custom_id: "noop_list",
//             disabled: true,
//           },
//           {
//             type: 2,
//             style: 1,
//             label: "Next ▶",
//             custom_id: `list:${safePage + 1}`,
//             disabled: safePage >= totalPage,
//           },
//         ],
//       },
//     ];

//     await editWithComponents(payload, content, components);
//   } catch (err) {
//     console.error("handleList error:", err);
//     await editInteractionResponse(payload.token, `❌ ${err.message}`);
//   }
// }
