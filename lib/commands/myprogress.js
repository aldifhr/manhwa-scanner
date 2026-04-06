import { getChapterNumber, normalizeTitleKey } from "../domain.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../discord.js";
import { waitUntil } from "@vercel/functions";
import { REDIS_SCAN_BATCH_SIZE } from "../config.js";

const PROGRESS_DATA_KEY = "users:progress_data";
const PROGRESS_LIST_KEY = "users:progress_list";

function buildToggleButton(state, title, chapter) {
  const isRead = state === "read";
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: isRead ? 4 : 3,
          label: isRead ? "Sudah Dibaca ✓" : "Tandai Sudah Baca",
          custom_id: `${isRead ? "unread" : "read"}:${title.slice(0, 70)}:${chapter.slice(0, 20)}`,
          disabled: false,
        },
      ],
    },
  ];
}

function safeJsonParse(str, defaultValue = {}) {
  if (!str) return defaultValue;
  if (typeof str === "object") return str;
  if (str === "[object Object]") return defaultValue;
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

function parseCustomId(customId) {
  const parts = customId.split(":");
  const action = parts.shift();
  const chapter = parts.pop();
  const title = parts.join(":");
  return { action, title, chapter };
}

async function getUserData(redis, userId, titleKey) {
  const usersDataStr = await redis.hget(PROGRESS_DATA_KEY, userId);
  const userData = safeJsonParse(usersDataStr, {});
  let existing = userData[titleKey];

  if (!existing) {
    const legacyHash = await redis.hget(
      `user:progress_data:${userId}`,
      titleKey,
    );
    existing = safeJsonParse(legacyHash, null);
  }

  if (!existing) {
    const legacyKey = await redis.get(`user:progress:${userId}:${titleKey}`);
    existing = safeJsonParse(legacyKey, null);
  }

  return { userData, existing };
}

async function saveUserData(redis, userId, userData, titleKey, newData) {
  const usersListStr = await redis.hget(PROGRESS_LIST_KEY, userId);
  const userList = safeJsonParse(usersListStr, []);
  const listMap = new Map(userList.map((i) => [i.member, i]));

  if (newData) {
    userData[titleKey] = newData;
    listMap.set(titleKey, { score: Date.now(), member: titleKey });
  } else {
    delete userData[titleKey];
    listMap.delete(titleKey);
  }

  const newList = Array.from(listMap.values()).sort(
    (a, b) => b.score - a.score,
  );

  await Promise.all([
    redis.hset(PROGRESS_DATA_KEY, { [userId]: JSON.stringify(userData) }),
    redis.hset(PROGRESS_LIST_KEY, { [userId]: JSON.stringify(newList) }),
    redis.del(`user:progress:${userId}:${titleKey}`),
    redis.hdel(`user:progress_data:${userId}`, titleKey),
    redis.zrem(`user:progress_list:${userId}`, titleKey),
  ]);
}

async function handleButtonClick(payload, res, redis, userId, options) {
  const customId = options[0].value;
  const { action, title, chapter } = parseCustomId(customId);
  const titleKey = normalizeTitleKey(title);

  if (!titleKey) {
    return res.json({
      type: 4,
      data: { content: "Invalid title.", flags: 64 },
    });
  }

  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const chapterNum = getChapterNumber(chapter);
        const newData = { timestamp: Date.now(), title, chapter, chapterNum };
        const { userData, existing } = await getUserData(
          redis,
          userId,
          titleKey,
        );

        if (action === "read") {
          if (!existing || chapterNum >= (existing.chapterNum ?? 0)) {
            await saveUserData(redis, userId, userData, titleKey, newData);
            const msg = `📚 **${title}** (Chapter ${chapter}) sudah ditandai masuk ke progress baca kamu!`;
            if (!(payload.message?.flags & 64)) {
              await editInteractionResponse(payload.token, {
                content: msg,
                flags: 64,
              });
            } else {
              await editInteractionResponseWithComponents(payload.token, {
                components: buildToggleButton("read", title, chapter),
              });
            }
          } else {
            await editInteractionResponse(payload.token, {
              content: `Judul ini sudah ada di progress kamu (Terakhir: **${existing.chapter}**).`,
              flags: 64,
            });
          }
        } else if (action === "unread") {
          await saveUserData(redis, userId, userData, titleKey, null);
          const isEphemeral = (payload.message?.flags & 64) === 64;
          if (!isEphemeral) {
            await editInteractionResponseWithComponents(payload.token, {
              components: buildToggleButton("unread", title, chapter),
            });
          } else {
            await editInteractionResponseWithComponents(payload.token, {
              components: buildToggleButton("read", title, chapter),
            });
          }
        }
      } catch (err) {
        console.error("[myprogress] Error processing button click:", err);
        await editInteractionResponse(payload.token, {
          content: `❌ Error: ${err.message ?? "Unknown error"}`,
          flags: 64,
        }).catch(() => {});
      }
    })(),
  );
}

async function handleClearCommand(payload, res, redis, userId, subOptions) {
  const query = subOptions.find((o) => o.name === "judul")?.value;
  if (!query) {
    return res.json({
      type: 4,
      data: {
        content: "❌ Masukkan judul manga yang ingin dihapus dari progres.",
        flags: 64,
      },
    });
  }

  const titleKey = normalizeTitleKey(query);
  res.json({ type: 5, data: { flags: 64 } });

  waitUntil(
    (async () => {
      try {
        const { userData, existing } = await getUserData(
          redis,
          userId,
          titleKey,
        );
        if (!existing) {
          return editInteractionResponse(
            payload,
            `❌ Progres untuk **${query}** tidak ditemukan.`,
          );
        }
        await saveUserData(redis, userId, userData, titleKey, null);
        return editInteractionResponse(
          payload,
          `✅ Berhasil menghapus **${existing.title ?? query}** dari progres baca kamu.`,
        );
      } catch (err) {
        console.error("[handleMyProgress clear] Error:", err);
        return editInteractionResponse(payload, `❌ Gagal: ${err.message}`);
      }
    })(),
  );
}

async function handleListCommand(payload, res, redis, userId, subOptions) {
  const page =
    parseInt(subOptions?.find((o) => o.name === "page")?.value, 10) || 1;

  if (!res.headersSent) {
    res.json({ type: 5, data: { flags: 64 } });
  }

  waitUntil(
    (async () => {
      try {
        let userList = [];
        let migratedFromLegacy = false;
        const usersListStr = await redis.hget(PROGRESS_LIST_KEY, userId);

        if (!usersListStr) {
          const legacyIndex = `user:progress_list:${userId}`;
          const legacyKeys = await redis.zrange(legacyIndex, 0, -1, {
            rev: true,
            withScores: true,
          });

          if (legacyKeys?.length > 0) {
            userList = legacyKeys
              .filter((_, i) => i % 2 === 0)
              .map((member, i) => ({
                member,
                score: legacyKeys[i * 2 + 1] ?? Date.now(),
              }));
            migratedFromLegacy = true;
          } else {
            const legacyHash = await redis.hgetall(
              `user:progress_data:${userId}`,
            );
            if (legacyHash && Object.keys(legacyHash).length > 0) {
              userList = Object.keys(legacyHash).map((tk) => ({
                member: tk,
                score: Date.now(),
              }));
              migratedFromLegacy = true;
            }
          }
        } else {
          userList = safeJsonParse(usersListStr, []);
        }

        const individualLegacyKeys = [];
        const listMap = new Map(userList.map((i) => [i.member, i]));

        for (const tk of listMap.keys()) {
          const legacyKey = `user:progress:${userId}:${tk}`;
          const legacyData = await redis.get(legacyKey);
          if (legacyData)
            individualLegacyKeys.push({ tk, key: legacyKey, data: legacyData });
        }

        if (userList.length === 0) {
          const scanPattern = `user:progress:${userId}:*`;
          let cursor = 0;
          do {
            const [nextCursor, keys] = await redis.scan(cursor, {
              match: scanPattern,
              count: REDIS_SCAN_BATCH_SIZE,
            });
            cursor = Number(nextCursor);
            for (const key of keys) {
              const data = await redis.get(key);
              if (data) {
                const tk = key.slice(`user:progress:${userId}:`.length);
                individualLegacyKeys.push({ tk, key, data });
                listMap.set(tk, { member: tk, score: Date.now() });
              }
            }
          } while (cursor !== 0);
        }

        const pageSize = 10;
        const allItems = Array.from(listMap.values()).sort(
          (a, b) => b.score - a.score,
        );
        const total = allItems.length;
        const totalPage = Math.ceil(total / pageSize) || 1;
        const pageSafe = Math.min(Math.max(1, page), totalPage);
        const start = (pageSafe - 1) * pageSize;
        const pagedItems = allItems.slice(start, start + pageSize);
        const titleKeys = pagedItems.map((i) => i.member);

        if (titleKeys.length === 0) {
          return editInteractionResponseWithComponents(
            payload,
            pageSafe > 1
              ? "Halaman ini kosong."
              : "Kamu belum menandai progress baca apapun.",
            [],
          );
        }

        const usersDataStr = await redis.hget(PROGRESS_DATA_KEY, userId);
        const userData = safeJsonParse(usersDataStr, {});
        const progressData = [];
        const migratedData = {};
        const legacyKeysToDelete = [];

        for (const tk of titleKeys) {
          if (userData[tk]) {
            progressData.push(userData[tk]);
          } else {
            let data =
              (await redis.hget(`user:progress_data:${userId}`, tk)) ??
              (await redis.get(`user:progress:${userId}:${tk}`));
            if (data) {
              data = safeJsonParse(data, data);
              progressData.push(data);
              migratedData[tk] = data;
              legacyKeysToDelete.push(`user:progress:${userId}:${tk}`);
            }
          }
        }

        for (const { tk, key, data } of individualLegacyKeys) {
          legacyKeysToDelete.push(key);
          if (!migratedData[tk]) migratedData[tk] = safeJsonParse(data, data);
        }

        if (
          migratedFromLegacy ||
          legacyKeysToDelete.length > 0 ||
          Object.keys(migratedData).length > 0
        ) {
          Object.assign(userData, migratedData);
          for (const tk of Object.keys(migratedData)) {
            if (!listMap.has(tk))
              listMap.set(tk, { member: tk, score: Date.now() });
          }
          const newList = Array.from(listMap.values()).sort(
            (a, b) => b.score - a.score,
          );

          await redis.hset(PROGRESS_DATA_KEY, {
            [userId]: JSON.stringify(userData),
          });
          await redis.hset(PROGRESS_LIST_KEY, {
            [userId]: JSON.stringify(newList),
          });
          await Promise.all(legacyKeysToDelete.map((k) => redis.del(k)));
          if (migratedFromLegacy) {
            await redis.del(`user:progress_list:${userId}`);
            await redis.del(`user:progress_data:${userId}`);
          }
        }

        const lines = progressData.map((p, i) => {
          const date = new Date(p.timestamp).toLocaleDateString("id-ID", {
            timeZone: "Asia/Jakarta",
          });
          return `${start + i + 1}. **${p.title ?? "Untitled"}** - ${p.chapter} (${date})`;
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

        return editInteractionResponseWithComponents(
          payload,
          content,
          components,
        );
      } catch (err) {
        console.error("[handleMyProgress] Error:", err);
        return editInteractionResponse(
          payload,
          `Terjadi kesalahan: ${err.message}`,
        );
      }
    })(),
  );
}

export default async function handleMyProgress(payload, options, res, redis) {
  const userId = payload.member?.user?.id ?? payload.user?.id;
  const isButton = options?.[0]?.name === "button";
  const subcommand = options?.[0]?.name;
  const subOptions = options?.[0]?.options ?? [];

  if (isButton) {
    return handleButtonClick(payload, res, redis, userId, options);
  }

  if (subcommand === "clear") {
    return handleClearCommand(payload, res, redis, userId, subOptions);
  }

  return handleListCommand(payload, res, redis, userId, subOptions);
}
