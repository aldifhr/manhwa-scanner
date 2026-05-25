import { Request, Response } from "express";
import { InteractionType, InteractionResponseType, verifyKey } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { redis } from "../lib/redis.js";
import { env } from "../lib/config/env.js";
import {
  editInteractionResponse,
} from "../lib/discord.js";
import { logApiError, logApiHit, logApiOk, runWithContext, generateCorrelationId } from "../lib/logger.js";
import { getLogger } from "../lib/logger.js";
import { z } from "zod";
import { discordInteractionSchema, safeParse } from "../lib/validation.js";
import {
  createErrorResponse,
} from "../lib/api/response.js";
import { DISCORD_EPHEMERAL_FLAG } from "../lib/config.js";
import { AppError } from "../lib/errors.js";
import commands from "../lib/commands/index.js";

const logger = getLogger({ scope: "api" });

export const config = { api: { bodyParser: false } };

async function handleInteractionError(
  payload: DiscordPayload | null,
  err: unknown,
  res: Response | null = null,
  reqLogger: ReturnType<typeof logApiHit> | null = null,
) {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const isPublic = isAppError ? err.isPublic : false;
  const displayMessage = isPublic
    ? (err instanceof Error ? err.message : String(err))
    : "❌ Terjadi kesalahan internal. Silakan coba lagi nanti.";

  // Log with context
  if (reqLogger) {
    logApiError(reqLogger, err, { status: statusCode, isPublic });
  } else {
    logger.error({ err, isPublic, payload: payload?.data?.name }, "Interaction error");
  }

  // Reply to Discord or HTTP
  if (res && !res.headersSent) {
    return res.status(statusCode).json(createErrorResponse(err, displayMessage));
  }

  // Post-interaction edit (if deferred)
  if (payload && payload.token) {
    try {
      await editInteractionResponse(payload, {
        content: displayMessage,
        flags: DISCORD_EPHEMERAL_FLAG,
      });
    } catch (discordErr) {
      logger.error({ discordErr }, "Failed to send error response to Discord");
    }
  }
}

type DiscordPayload = z.infer<typeof discordInteractionSchema>;
function getUserId(payload: DiscordPayload) {
  return payload.member?.user?.id ?? payload.user?.id;
}

async function getRawBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleListResponse(
  payload: DiscordPayload,
  page: number,
  reqLogger: ReturnType<typeof logApiHit>,
  event: string,
  options = {},
) {
  try {
      const { buildWhitelistListResponse } = await import("../lib/services/whitelist.js");
      const { editInteractionResponseWithComponents } = await import("../lib/discord.js");
    const { content, components } = await buildWhitelistListResponse(
      page,
      10,
      options,
    );
    await editInteractionResponseWithComponents(payload, content, components);
    logApiOk(reqLogger, { status: 200, event });
  } catch (err) {
    await handleInteractionError(payload, err, null, reqLogger);
  }
}

export default async function handler(req: Request, res: Response) {
  // Generate correlation ID for this request
  const correlationId = generateCorrelationId();
  
  // Run handler with correlation context
  return runWithContext({
    correlationId,
    requestId: correlationId,
    path: req.path,
    method: req.method,
  }, async () => {
    const reqLogger = logApiHit("interactive", req);
    // Add correlation ID to logger
    reqLogger.correlationId = correlationId;

    try {
      if (req.method !== "POST") {
        logApiOk(reqLogger, { status: 405 });
        return res.status(405).end();
      }

      // --- WARMING LOGIC ---
      // Check for warming header to skip expensive signature verification
      const isWarmup = req.headers["x-warmup"] === env.CRON_SECRET || req.query.warmup === env.CRON_SECRET;
      if (isWarmup) {
        logApiOk(reqLogger, { status: 200, event: "warmup" });
        return res.status(200).json({ ok: true, message: "Warmed up" });
      }
      // ---------------------

      const sig = req.headers["x-signature-ed25519"] as string;
      const ts = req.headers["x-signature-timestamp"] as string;
      const raw = await getRawBody(req);
      const rawString = raw.toString();

      const isValid = await verifyKey(
        rawString,
        sig,
        ts,
        (env.DISCORD_PUBLIC_KEY || "") as string,
      );
      if (!isValid) {
        logApiOk(reqLogger, { status: 401, reason: "invalid_signature" });
        return res.status(401).end();
      }

      let payload: any;
      try {
        payload = JSON.parse(rawString);
      } catch (err: unknown) {
        logApiError(reqLogger, err, { status: 400, reason: "invalid_json" });
        return res.status(400).json({ error: "Invalid JSON body" });
      }

    // Handle PING BEFORE schema validation — Discord's verification request
    // only sends {"type": 1} without id/application_id, so it would fail schema checks.
    if (payload?.type === InteractionType.PING) {
      logApiOk(reqLogger, { status: 200, interactionType: "PING" });
      return res.json({ type: InteractionResponseType.PONG });
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

    const interaction = validation.data;
    const { type, data: interactionData } = interaction;
    const commandName = interactionData?.name;
    const commandOptions = interactionData?.options || [];

    // PING already handled above — remaining types below

    if (type === InteractionType.MESSAGE_COMPONENT) {
      const customId = interactionData?.custom_id || "";

      if (customId.startsWith("list:")) {
        const parts = customId.split(":");
        if (parts.length < 2) {
          logApiOk(reqLogger, { status: 400, reason: "invalid_list_format" });
          return res.status(400).json({ error: "Invalid list format" });
        }
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

        res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
        waitUntil((async () => {
          const { buildWhitelistListResponse } = await import("../lib/services/whitelist.js");
          const { editInteractionResponseWithComponents } = await import("../lib/discord.js");
          const { content, components } = await buildWhitelistListResponse(page, 10, {
            search: search || null,
            filter: filter || null,
          });
          await editInteractionResponseWithComponents(payload, content, components);
        })());
        return;
      }

      if (customId.startsWith("follow:list:")) {
        const parts = customId.split(":");
        const page = parts.length >= 3 ? parseInt(parts[2], 10) || 1 : 1;

        res.json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
        const handlerGetter = commands["follow"];
        if (handlerGetter) {
          const handler = await handlerGetter();
          waitUntil(
            handler(
              payload,
              [{ name: "button", value: customId }, { name: "page", value: page }],
              res,
              redis,
            ),
          );
          return;
        }
      }

      if (customId.startsWith("follow_toggle:")) {
        const userId = getUserId(payload);
        const title = customId.slice("follow_toggle:".length);

        if (!userId) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "❌ Error: Could not identify user.",
              flags: DISCORD_EPHEMERAL_FLAG,
            },
          });
        }

        res.json({
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: DISCORD_EPHEMERAL_FLAG },
        });

        waitUntil(
          (async () => {
            try {
              const { isUserFollowing, followManga, unfollowManga, getUserNotifyMode } = await import("../lib/services/notifications.js");
              const [following, notifyMode] = await Promise.all([
                isUserFollowing(userId, title),
                getUserNotifyMode(userId),
              ]);

              let finalContent = "";
              if (following) {
                await unfollowManga(userId, title);
                finalContent = `🔖 **Bookmark Dihapus**\n\nBookmark untuk **${title}** telah dihapus.\n\nMode notifikasi: ${
                  notifyMode === "all"
                    ? '"All" - Kamu masih dapat notif semua manga'
                    : '"Follows" - Hanya manga yang di-bookmark'
                }.`;
              } else {
                await followManga(userId, title);
                finalContent = `🔖 **Bookmark Ditambahkan**\n\n**${title}** telah ditambahkan ke bookmark!\n\nMode notifikasi: ${
                  notifyMode === "all"
                    ? '"All" - Kamu dapat notif semua manga'
                    : '"Follows" - Kamu akan di-tag saat chapter baru'
                }`;
              }

              await editInteractionResponse(payload, finalContent);
            } catch (err: unknown) {
              logger.error({ err: err instanceof Error ? err.message : String(err) }, "[follow_toggle] Async error:");
              await editInteractionResponse(
                payload,
                "❌ Gagal memproses bookmark. Silakan coba lagi.",
              );
            }
          })(),
        );
        return;
      }

      logApiOk(reqLogger, { status: 400, reason: "unknown_component" });
      return res
        .status(400)
        .json(createErrorResponse("UNKNOWN_COMPONENT", "Unknown component"));
    }

    if (type === InteractionType.APPLICATION_COMMAND) {
      const handlerGetter = commands[commandName!];

      if (!handlerGetter) {
        logApiOk(reqLogger, {
          status: 400,
          reason: "unknown_command",
          command: commandName,
        });
        return res
          .status(400)
          .json(createErrorResponse("UNKNOWN_COMMAND", "Unknown command"));
      }

      logApiOk(reqLogger, {
        status: 200,
        event: "command_dispatch",
        command: commandName,
      });

      const cmdHandler = await handlerGetter();
      return cmdHandler(payload, commandOptions || [], res, redis);
    }

    logApiError(reqLogger, new Error("Unknown interaction type"), {
      status: 400,
    });
    return res
      .status(400)
      .json(
        createErrorResponse("UNKNOWN_INTERACTION_TYPE", "Unknown interaction type"),
      );
    } catch (err: unknown) {
      await handleInteractionError(null, err, res, reqLogger);
    }
  });
}
