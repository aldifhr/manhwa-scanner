/**
 * Discord interaction response handling
 */

import { httpPatch, httpPost } from "../httpClient.js";
import { getLogger } from "../logger.js";
import {
  DISCORD_EPHEMERAL_FLAG,
} from "../config.js";
import { env } from "../config/env.js";
import { BOT_TOKEN } from "./common.js";

const logger = getLogger({ scope: "discord:interactions" });
const APP_ID = env.DISCORD_APPLICATION_ID;

/**
 * Send fallback message to channel when webhook fails
 */
async function sendChannelFallback(
  channelId: string,
  userId: string | null | undefined,
  body: { content?: string; components?: unknown[]; embeds?: unknown[] },
  callerName: string,
): Promise<void> {
  const mention = userId ? `<@${userId}>\n` : "";
  const fallbackContent = mention + (body.content || "Interaction complete.");
  try {
    await httpPost(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { content: fallbackContent, ...(body.components && { components: body.components }), ...(body.embeds && { embeds: body.embeds }) },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" } },
    );
    logger.debug(`[${callerName}] Channel fallback succeeded`);
  } catch (fallbackErr: unknown) {
    const fbMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    logger.error({ err: fbMessage }, `[${callerName}] Channel fallback failed`);
  }
}

/**
 * Edit the original interaction response
 */
export async function editInteractionResponse(token: unknown, content: unknown): Promise<void> {
  const t = typeof token === "object" && token !== null ? (token as { token?: string }).token : String(token);
  const channelId = typeof token === "object" && token !== null ? (token as { channel_id?: string }).channel_id : null;
  const userId = typeof token === "object" && token !== null
    ? ((token as { member?: { user?: { id?: string } }; user?: { id?: string } }).member?.user?.id || (token as { user?: { id?: string } }).user?.id)
    : null;
  const appId = typeof token === "object" && token !== null && (token as { application_id?: string }).application_id
    ? (token as { application_id?: string }).application_id
    : APP_ID;

  if (!appId) {
    logger.error({ 
      hasToken: !!t, 
      hasAppIdInPayload: !!(typeof token === "object" && token !== null && (token as { application_id?: string }).application_id),
      hasAppIdInEnv: !!APP_ID,
      tokenType: typeof token 
    }, "[editInteractionResponse] DISCORD_APPLICATION_ID not configured");
    throw new Error("DISCORD_APPLICATION_ID not configured");
  }

  if (!t) {
    throw new Error("Interaction token not provided");
  }

  let body: { content?: string; [key: string]: unknown } = {};
  if (typeof content === "string") {
    const safeContent =
      content.length > 2000 ? `${content.substring(0, 1997)}...` : content;
    body = { content: safeContent || undefined };
  } else if (content && typeof content === "object") {
    body = { ...content as Record<string, unknown> };
    if (body.content && typeof body.content === "string" && body.content.length > 2000) {
      body.content = `${body.content.substring(0, 1997)}...`;
    }
  }

  try {
    await httpPatch(
      `https://discord.com/api/v10/webhooks/${appId}/${t}/messages/@original`,
      body,
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const axiosError = err as { response?: { status?: number } };
    if (axiosError.response?.status === 404 && channelId) {
      logger.debug("[editInteractionResponse] 404 Unknown Webhook, using channel message fallback");
      await sendChannelFallback(channelId, userId, body, "editInteractionResponse");
      return;
    }

    logger.error({
      err: message,
      status: axiosError.response?.status,
      appId: appId ? "set" : "missing",
      token: t ? "present" : "missing",
      tokenLength: t?.length,
    }, "[editInteractionResponse] Failed");
    throw err;
  }
}

/**
 * Create a follow-up message to an interaction
 */
export async function createFollowUpMessage(
  token: unknown,
  content: string | null,
  options: { ephemeral?: boolean; components?: unknown[]; embeds?: unknown[] } = {},
): Promise<void> {
  const t = typeof token === "object" && token !== null ? (token as { token?: string }).token : String(token);
  const channelId = typeof token === "object" && token !== null ? (token as { channel_id?: string }).channel_id : null;
  const userId = typeof token === "object" && token !== null
    ? ((token as { member?: { user?: { id?: string } }; user?: { id?: string } }).member?.user?.id || (token as { user?: { id?: string } }).user?.id)
    : null;
  const appId = typeof token === "object" && token !== null && (token as { application_id?: string }).application_id
    ? (token as { application_id?: string }).application_id
    : APP_ID;

  if (!appId) {
    throw new Error("DISCORD_APPLICATION_ID not configured");
  }

  if (!t) {
    throw new Error("Interaction token not provided");
  }

  const safeContent =
    content && content.length > 2000 ? `${content.substring(0, 1997)}...` : content;

  const body: { content?: string; flags?: number; components?: unknown[]; embeds?: unknown[] } = {
    content: safeContent || undefined,
    flags: options.ephemeral ? DISCORD_EPHEMERAL_FLAG : undefined,
  };

  if (options.components?.length) {
    body.components = options.components;
  }

  if (options.embeds?.length) {
    body.embeds = options.embeds;
  }

  try {
    await httpPost(
      `https://discord.com/api/v10/webhooks/${appId}/${t}`,
      body,
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
    );
    logger.debug("[createFollowUpMessage] Follow-up message sent successfully");
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const axiosError = err as { response?: { status?: number } };
    if (channelId) {
      logger.debug("[createFollowUpMessage] Webhook failed, using channel message fallback");
      await sendChannelFallback(channelId, userId, { content: safeContent ?? undefined, components: options.components, embeds: options.embeds }, "createFollowUpMessage");
      return;
    }

    logger.error({
      err: errMessage,
      status: axiosError.response?.status,
      appId: appId ? "set" : "missing",
      token: t ? "present" : "missing",
    }, "[createFollowUpMessage] Failed");
    throw err;
  }
}

/**
 * Edit interaction response with components
 */
export async function editInteractionResponseWithComponents(
  token: unknown,
  content: string | null,
  components: unknown[],
  embeds: unknown[] = [],
): Promise<void> {
  const t = typeof token === "object" && token !== null ? (token as { token?: string }).token : String(token);
  const channelId = typeof token === "object" && token !== null ? (token as { channel_id?: string }).channel_id : null;
  const userId = typeof token === "object" && token !== null
    ? ((token as { member?: { user?: { id?: string } }; user?: { id?: string } }).member?.user?.id || (token as { user?: { id?: string } }).user?.id)
    : null;
  const appId = typeof token === "object" && token !== null && (token as { application_id?: string }).application_id
    ? (token as { application_id?: string }).application_id
    : APP_ID;

  if (!appId) {
    throw new Error("DISCORD_APPLICATION_ID not configured");
  }

  if (!t) {
    throw new Error("Interaction token not provided");
  }

  const safeContent =
    content && content.length > 2000 ? `${content.substring(0, 1997)}...` : content;

  try {
    await httpPatch(
      `https://discord.com/api/v10/webhooks/${appId}/${t}/messages/@original`,
      { content: safeContent || undefined, components, embeds },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
      { retries: 3, baseDelayMs: 300, maxDelayMs: 4000 },
    );
  } catch (err: unknown) {
    const axiosError = err as { response?: { status?: number } };
    if (axiosError.response?.status === 404 && channelId) {
      logger.debug("[editInteractionResponseWithComponents] 404 Unknown Webhook, using channel message fallback");
      await sendChannelFallback(channelId, userId, { content: safeContent ?? undefined, components, embeds }, "editInteractionResponseWithComponents");
      return;
    }
    logger.error({ err }, "[editInteractionResponseWithComponents] Failed");
    throw err;
  }
}
