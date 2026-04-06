import { InteractionType, verifyKey } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { redis } from "../lib/redis.js";
import {
  editInteractionResponse,
  editInteractionResponseWithComponents,
} from "../lib/discord.js";
import commands from "../lib/commands/index.js";
import {
  buildAddAutocompleteChoices,
  resolveAddResultValue,
} from "../lib/commands/add.js";
import { logApiError, logApiHit, logApiOk } from "../lib/logger.js";
import { normalizeSource } from "../lib/domain.js";
import { isAddAllowedUser } from "../lib/permissions.js";
import { addWhitelistEntry } from "../lib/services/whitelist.js";
import {
  buildAddExistsMessage,
  buildAddSuccessMessage,
  buildWhitelistListResponse,
} from "../lib/services/whitelist.js";
import { discordInteractionSchema, safeParse } from "../lib/validation.js";

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleAddManga(payload, title, url = null, source = "ikiru") {
  try {
    const result = await addWhitelistEntry({ title, url, source });

    if (result.status === "exists") {
      await editInteractionResponse(payload, buildAddExistsMessage(result));
      return;
    }

    await editInteractionResponse(
      payload,
      buildAddSuccessMessage({
        ...result,
        total: result.whitelist.length,
      }),
    );
  } catch (err) {
    console.error("[handleAddManga] Error:", err);
    await editInteractionResponse(payload, `Error: ${err.message}`);
  }
}

async function handleListResponse(
  payload,
  page,
  reqLogger,
  event,
  options = {},
) {
  try {
    const { content, components } = await buildWhitelistListResponse(
      page,
      10,
      options,
    );
    await editInteractionResponseWithComponents(payload, content, components);
    logApiOk(reqLogger, { status: 200, event });
  } catch (err) {
    logApiError(reqLogger, err, { status: 500, event });
    await editInteractionResponse(payload, `Error: ${err.message}`);
  }
}

async function resolveAddSelection(interactionData) {
  const rawValue = String(interactionData.values?.[0] || "");
  let { cached, item, selectedSource } = await resolveAddResultValue(
    rawValue,
    redis,
  );

  if (!item) {
    const parts = rawValue.split("|||");
    const [rawSource, keyword, id] = parts;
    cached = await redis.get(`add:results:${rawSource}:${keyword}`);
    const results = Array.isArray(cached) ? cached : [];
    item = results.find((r) => (r.slug ?? r.mangaUrl ?? r.url) === id);
    selectedSource = normalizeSource(item?.source || rawSource);
  }

  return { cached, item, selectedSource };
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("interactive", req);

  try {
    if (req.method !== "POST") {
      logApiOk(reqLogger, { status: 405 });
      return res.status(405).end();
    }

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
    if (!isValid) {
      logApiOk(reqLogger, { status: 401, reason: "invalid_signature" });
      return res.status(401).end();
    }

    let payload;
    try {
      payload = JSON.parse(rawString);
    } catch (err) {
      logApiError(reqLogger, err, { status: 400, reason: "invalid_json" });
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const validation = safeParse(discordInteractionSchema, payload);
    if (!validation.success) {
      logApiOk(reqLogger, {
        status: 400,
        reason: "invalid_payload",
        errors: validation.errors,
      });
      return res.status(400).json({
        error: "Invalid interaction payload",
        details: validation.errors,
      });
    }

    const { type, data: interactionData } = payload;

    if (type === 1) {
      logApiOk(reqLogger, { status: 200, interactionType: type });
      return res.json({ type: 1 });
    }

    if (type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
      const { name, options } = interactionData;

      if (name !== "add") {
        logApiOk(reqLogger, {
          status: 200,
          event: "autocomplete_ignored",
          command: name,
        });
        return res.json({ type: 8, data: { choices: [] } });
      }

      if (!(await isAddAllowedUser(payload, redis))) {
        logApiOk(reqLogger, { status: 200, event: "autocomplete_add_denied" });
        return res.json({ type: 8, data: { choices: [] } });
      }

      const choices = await buildAddAutocompleteChoices(options, redis);

      logApiOk(reqLogger, {
        status: 200,
        event: "autocomplete_add",
        count: choices.length,
      });
      return res.json({ type: 8, data: { choices } });
    }

    if (type === InteractionType.MESSAGE_COMPONENT) {
      const { custom_id } = interactionData;

      if (custom_id === "select_add_src") {
        if (!(await isAddAllowedUser(payload, redis))) {
          logApiOk(reqLogger, { status: 200, event: "add_selection_denied" });
          return res.json({
            type: 4,
            data: {
              content: "Command `/add` hanya diizinkan untuk user tertentu.",
              flags: 64,
            },
          });
        }

        const { cached, item, selectedSource } =
          await resolveAddSelection(interactionData);

        if (!cached) {
          logApiOk(reqLogger, { status: 200, event: "add_session_expired" });
          return res.json({
            type: 4,
            data: { content: "Session expired. Run /add again.", flags: 64 },
          });
        }

        if (!item) {
          logApiOk(reqLogger, {
            status: 200,
            event: "add_selection_not_found",
          });
          return res.json({
            type: 4,
            data: {
              content: "Selected manga not found. Run /add again.",
              flags: 64,
            },
          });
        }

        res.json({ type: 5, data: { flags: 64 } });
        logApiOk(reqLogger, { status: 200, event: "add_selection_ack" });
        return waitUntil(
          handleAddManga(
            payload,
            item.title,
            item.mangaUrl ?? item.url,
            selectedSource,
          ),
        );
      }

      if (custom_id.startsWith("list:")) {
        const parts = custom_id.split(":");
        const page = parseInt(parts[1], 10) || 1;
        const remainder = parts.slice(2).join(":");

        let search = null;
        let filter = null;

        if (remainder) {
          const pipeIndex = remainder.lastIndexOf("|");
          if (pipeIndex !== -1) {
            search = remainder.substring(0, pipeIndex) || null;
            filter = remainder.substring(pipeIndex + 1) || null;
          } else {
            search = remainder;
          }
        }

        res.json({ type: 6 });
        return waitUntil(
          handleListResponse(payload, page, reqLogger, "list_component", {
            search: search || null,
            filter: filter || null,
          }),
        );
      }
      if (custom_id.startsWith("myprogress:")) {
        const parts = custom_id.split(":");
        const page = parseInt(parts[1], 10) || 1;

        res.json({ type: 6 });
        const handleProgress = commands["myprogress"];
        if (handleProgress) {
          return waitUntil(
            handleProgress(
              payload,
              [{ name: "page", value: page }],
              res,
              redis,
            ),
          );
        }
      }
      if (custom_id.startsWith("follow:list:")) {
        void custom_id.split(":");

        res.json({ type: 6 });
        const handleFollow = commands["follow"];
        if (handleFollow) {
          return waitUntil(
            handleFollow(
              payload,
              [{ name: "button", value: custom_id }],
              res,
              redis,
            ),
          );
        }
      }

      if (custom_id.startsWith("read:") || custom_id.startsWith("unread:")) {
        const handleProgress = commands["myprogress"];
        if (handleProgress) {
          return handleProgress(
            payload,
            [{ name: "button", value: custom_id }],
            res,
            redis,
          );
        }
      }

      if (custom_id.startsWith("follow_toggle:")) {
        const userId = payload.member?.user?.id ?? payload.user?.id;
        const title = custom_id.slice("follow_toggle:".length);

        if (!userId) {
          return res.json({
            type: 4,
            data: { content: "❌ Error: Could not identify user.", flags: 64 },
          });
        }

        res.json({ type: 5, data: { flags: 64 } });

        return waitUntil(
          (async () => {
            try {
              const {
                isUserFollowing,
                followManga,
                unfollowManga,
                getUserNotifyMode,
              } = await import("../lib/services/notifications.js");

              const following = await isUserFollowing(userId, title);
              const notifyMode = await getUserNotifyMode(userId);

              if (following) {
                await unfollowManga(userId, title);
                try {
                  return await editInteractionResponse(
                    payload,
                    `🔕 **Unfollowed**\n\nKamu berhenti mengikuti **${title}**.\n\nMode notifikasi: ${notifyMode === "all" ? '"All" - Kamu masih dapat notif semua manga' : '"Follows" - Hanya manga yang di-follow'}.\n\nKlik "🔔 Follow Updates" lagi untuk mengikuti kembali.`,
                  );
                } catch (editErr) {
                  console.warn(
                    `[follow_toggle] Failed to edit response (token expired?): ${editErr.message}`,
                  );
                  return; // Silent fail - action already succeeded
                }
              } else {
                await followManga(userId, title);
                try {
                  return await editInteractionResponse(
                    payload,
                    `🔔 **Now Following**\n\nKamu mengikuti **${title}**!\n\nMode notifikasi: ${notifyMode === "all" ? '"All" - Kamu dapat notif semua manga' : '"Follows" - Kamu akan di-tag saat chapter baru'}\n\nKlik "🔔 Follow Updates" lagi untuk berhenti mengikuti.`,
                  );
                } catch (editErr) {
                  console.warn(
                    `[follow_toggle] Failed to edit response (token expired?): ${editErr.message}`,
                  );
                  return; // Silent fail - action already succeeded
                }
              }
            } catch (err) {
              console.error("[follow_toggle] Error:", err);
              try {
                return await editInteractionResponse(
                  payload,
                  `❌ Gagal memproses: ${err.message}`,
                );
              } catch (editErr) {
                console.warn(
                  `[follow_toggle] Failed to edit error response: ${editErr.message}`,
                );
                return; // Silent fail
              }
            }
          })(),
        );
      }

      logApiOk(reqLogger, { status: 400, reason: "unknown_component" });
      return res.status(400).json({ error: "Unknown component" });
    }

    if (type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interactionData;

      const handle = commands[name];

      if (!handle) {
        logApiOk(reqLogger, {
          status: 400,
          reason: "unknown_command",
          command: name,
        });
        return res.status(400).json({ error: "Unknown command" });
      }

      logApiOk(reqLogger, {
        status: 200,
        event: "command_dispatch",
        command: name,
      });
      return handle(payload, options, res, redis);
    }

    logApiError(reqLogger, new Error("Unknown interaction type"), {
      status: 400,
    });
    return res.status(400).json({ error: "Unknown interaction type" });
  } catch (err) {
    console.error("[interactive] Unhandled error:", err);
    logApiError(reqLogger, err, { status: 500 });
    if (!res.headersSent) {
      return res.status(500).json({ error: "Internal server error" });
    }
  }
}
