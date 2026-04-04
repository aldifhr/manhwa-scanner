import { normalizeTitleKey, getChapterNumber } from "../domain.js";
import { editInteractionResponse, editInteractionResponseWithComponents } from "../discord.js";
import { waitUntil } from "@vercel/functions";

function buildToggleButton(state, title, chapter) {
  const isRead = state === "read";
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: isRead ? 4 : 3, // 4 = Danger/Red, 3 = Success/Green
          label: isRead ? "Sudah Dibaca ✓" : "Tandai Sudah Baca",
          custom_id: `${isRead ? "unread" : "read"}:${title.slice(0, 70)}:${chapter.slice(0, 20)}`,
          disabled: false,
        },
      ],
    },
  ];
}

export default async function handleMyProgress(payload, options, res, redis) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const isButton = options?.[0]?.name === "button";

  if (isButton) {
    // Handling "Mark as Read" button toggle
    const customId = options[0].value;
    
    // Gunakan shift() dan pop() untuk menghindari bug jika judul manga mengandung tanda titik dua ":" (misal: "Re:Zero")
    const parts = customId.split(":");
    const action = parts.shift();       // ambil 'read' / 'unread' di awal
    const chapter = parts.pop();        // ambil 'chapter' di akhir
    const title = parts.join(":");      // gabungkan sisa array text untuk 'title'

    const titleKey = normalizeTitleKey(title);
    
    if (!titleKey) {
      return res.json({ type: 4, data: { content: "Invalid title.", flags: 64 } });
    }

    const progressDataKey = `users:progress_data`;
    const progressListKey = `users:progress_list`;
    const progressKeyLegacy = `user:progress:${userId}:${titleKey}`; // Sangat lama
    const progressDataKeyLegacy = `user:progress_data:${userId}`; // Hash per-user lama
    
    let resultMessage = `📚 **${title}** (Chapter ${chapter}) sudah ditandai masuk ke progress baca kamu!`;
    const chapterNum = getChapterNumber(chapter);
    const newData = { timestamp: Date.now(), title, chapter, chapterNum };
    
    // Coba ambil dari Master Hash
    let usersDataStr = await redis.hget(progressDataKey, userId);
    let userData = usersDataStr ? JSON.parse(usersDataStr) : {};
    let existingProgress = userData[titleKey];

    // Fallback migration check
    if (!existingProgress) {
      existingProgress = await redis.hget(progressDataKeyLegacy, titleKey);
      if (!existingProgress) existingProgress = await redis.get(progressKeyLegacy);
    }

    if (action === "read") {
      if (!existingProgress || chapterNum >= existingProgress.chapterNum) {
        userData[titleKey] = newData;
        
        let usersListStr = await redis.hget(progressListKey, userId);
        let userList = usersListStr ? JSON.parse(usersListStr) : [];
        userList = userList.filter(i => i.member !== titleKey);
        userList.push({ score: Date.now(), member: titleKey });
        userList.sort((a,b) => b.score - a.score);

        await Promise.all([
          redis.hset(progressDataKey, { [userId]: JSON.stringify(userData) }),
          redis.hset(progressListKey, { [userId]: JSON.stringify(userList) }),
          redis.del(progressKeyLegacy),
          redis.del(progressDataKeyLegacy),
          redis.del(`user:progress_list:${userId}`) // zset legacy cleanup
        ]);
      } else {
        resultMessage = `Judul ini sudah ada di progress kamu (Terakhir: **${existingProgress.chapter}**).`;
      }
    } else if (action === "unread") {
      delete userData[titleKey];
      let usersListStr = await redis.hget(progressListKey, userId);
      let userList = usersListStr ? JSON.parse(usersListStr) : [];
      let filteredList = userList.filter(i => i.member !== titleKey);

      await Promise.all([
        redis.hset(progressDataKey, { [userId]: JSON.stringify(userData) }),
        redis.hset(progressListKey, { [userId]: JSON.stringify(filteredList) }),
        redis.del(progressKeyLegacy),
        redis.hdel(progressDataKeyLegacy, titleKey),
        redis.zrem(`user:progress_list:${userId}`, titleKey)
      ]);
    }

    const isMessageEphemeral = (payload.message?.flags & 64) === 64;

    if (!isMessageEphemeral) {
      // In public channels:
      // 1. If clicking 'read' (green button): Just send ephemeral confirm, DON'T change button to red.
      // 2. If clicking 'unread' (red button - usually stuck from old behavior): Update back to green for everyone.
      
      if (action === "unread") {
        return res.json({
          type: 7, // UPDATE_MESSAGE
          data: { components: buildToggleButton("unread", title, chapter) },
        });
      }

      return res.json({
        type: 4,
        data: {
          content: resultMessage,
          flags: 64,
        },
      });
    }

    return res.json({
      type: 7, // UPDATE_MESSAGE
      data: { components: buildToggleButton("read", title, chapter) },
    });
  }

  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options || [];

  if (subcommand === "clear") {
    // Handling "/myprogress clear [judul]"
    const query = subOptions.find(o => o.name === "judul")?.value;
    if (!query) {
      return res.json({ type: 4, data: { content: "❌ Masukkan judul manga yang ingin dihapus dari progres.", flags: 64 } });
    }

    const titleKey = normalizeTitleKey(query);
    const progressDataKey = `users:progress_data`;
    const progressListKey = `users:progress_list`;

    res.json({ type: 5, data: { flags: 64 } });
    waitUntil((async () => {
      try {
        let usersDataStr = await redis.hget(progressDataKey, userId);
        let userData = usersDataStr ? JSON.parse(usersDataStr) : {};
        let existing = userData[titleKey];
        
        if (!existing) {
          existing = await redis.hget(`user:progress_data:${userId}`, titleKey);
        }
        
        if (!existing) {
          return editInteractionResponse(payload, `❌ Progres untuk **${query}** tidak ditemukan.`);
        }
        
        delete userData[titleKey];
        let usersListStr = await redis.hget(progressListKey, userId);
        let userList = usersListStr ? JSON.parse(usersListStr) : [];
        let filteredList = userList.filter(i => i.member !== titleKey);
        
        await Promise.all([
          redis.hset(progressDataKey, { [userId]: JSON.stringify(userData) }),
          redis.hset(progressListKey, { [userId]: JSON.stringify(filteredList) })
        ]);
        
        return editInteractionResponse(payload, `✅ Berhasil menghapus **${existing.title || query}** dari progres baca kamu.`);
      } catch (err) {
        console.error("[handleMyProgress clear] Error:", err);
        return editInteractionResponse(payload, `❌ Gagal: ${err.message}`);
      }
    })());
    return;
  }

  // Handling /myprogress list (default behavior)
  const page = parseInt(subOptions?.find(o => o.name === "page")?.value, 10) || 1;
  if (!res.headersSent) {
    res.json({ type: 5, data: { flags: 64 } });
  }

  waitUntil(
    (async () => {
      try {
        const progressListKey = `users:progress_list`;
        const progressDataKey = `users:progress_data`;
        
        let usersListStr = await redis.hget(progressListKey, userId);
        let userList = null;
        
        if (!usersListStr) {
            // Check legacy ZSET
            const indexKeyLegacy = `user:progress_list:${userId}`;
            let titleKeysLegacy = await redis.zrange(indexKeyLegacy, 0, -1, { rev: true, withScores: true });
            
            if (titleKeysLegacy && titleKeysLegacy.length > 0) {
               userList = titleKeysLegacy.map((tk, i) => {
                  return { member: tk, score: titleKeysLegacy[i+1] || Date.now() }; // In Upstash withScores sometimes returns interleaved [member, score, member, score] 
               }).filter(i => typeof i.member === 'string'); // basic fix
            } else {
               userList = [];
            }
        } else {
            userList = JSON.parse(usersListStr);
        }

        const pageSize = 10;
        const total = userList.length;
        const totalPage = Math.ceil(total / pageSize) || 1;
        const pageSafe = Math.min(Math.max(1, page), totalPage);

        const start = (pageSafe - 1) * pageSize;
        const end = start + pageSize;

        const pagedItems = userList.slice(start, end);
        const titleKeys = pagedItems.map(i => i.member);
        
        if (!titleKeys || titleKeys.length === 0) {
          return editInteractionResponseWithComponents(payload, pageSafe > 1 ? "Halaman ini kosong." : "Kamu belum menandai progress baca apapun.", []);
        }

        let usersDataStr = await redis.hget(progressDataKey, userId);
        let userData = usersDataStr ? JSON.parse(usersDataStr) : {};
        
        const progressData = [];
        for (const tk of titleKeys) {
            if (userData[tk]) {
               progressData.push(userData[tk]);
            } else {
               const legacyKey = `user:progress:${userId}:${tk}`;
               let data = await redis.hget(`user:progress_data:${userId}`, tk);
               if (!data) data = await redis.get(legacyKey);
               if (data) progressData.push(data);
            }
        }

        if (progressData.length === 0) {
          return editInteractionResponseWithComponents(payload, pageSafe > 1 ? "Halaman ini kosong." : "Kamu belum menandai progress baca apapun.", []);
        }

        const lines = progressData.map((p, i) => {
          const date = new Date(p.timestamp).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
          const displayTitle = p.title || "Untitled";
          return `${start + i + 1}. **${displayTitle}** - ${p.chapter} (${date})`;
        });

        const footer = `\n*Halaman ${pageSafe}/${totalPage}*`;
        const content = `📚 **Progress Baca Kamu:**\n\n${lines.join("\n")}${footer}`;
        
        const components = [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Sebelumnya",
                custom_id: `myprogress:${pageSafe - 1}`,
                disabled: pageSafe <= 1,
              },
              {
                type: 2,
                style: 2,
                label: `Hal ${pageSafe}`,
                custom_id: "noop",
                disabled: true,
              },
              {
                type: 2,
                style: 1,
                label: "Berikutnya",
                custom_id: `myprogress:${pageSafe + 1}`,
                disabled: pageSafe >= totalPage,
              },
            ],
          },
        ];

        return editInteractionResponseWithComponents(payload, content, components);
      } catch (err) {
        console.error("[handleMyProgress] Error:", err);
        return editInteractionResponse(payload, `Terjadi kesalahan: ${err.message}`);
      }
    })()
  );
}

