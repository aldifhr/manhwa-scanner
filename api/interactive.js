import { verifyKey, InteractionType } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { redis } from "../lib/redis.js";
import { editInteractionResponse } from "../lib/discord.js";
import commands from "../lib/commands/index.js";
import { logApiError, logApiHit, logApiOk } from "../lib/requestLog.js";
import { normalizeSource } from "../lib/domain/source.js";
import {
  addWhitelistEntry,
  buildAddExistsMessage,
  buildAddSuccessMessage,
  buildWhitelistListResponse,
} from "../lib/services/whitelist.js";

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

async function resolveAddSelection(interactionData) {
  const rawValue = String(interactionData.values?.[0] || "");
  const parts = rawValue.split("|||");

  let cached = null;
  let item = null;
  let selectedSource = "ikiru";

  if (parts.length === 2) {
    const [sessionId, idxRaw] = parts;
    const sessionSource = normalizeSource(sessionId.split(":")[0] || "ikiru");
    cached = await redis.get(`add:results:${sessionId}`);
    const idx = Number.parseInt(idxRaw, 10);
    const results = Array.isArray(cached) ? cached : [];
    if (Number.isInteger(idx) && idx >= 0 && idx < results.length) {
      item = results[idx];
    }
    selectedSource = normalizeSource(item?.source || sessionSource);
  } else {
    const [rawSource, keyword, id] = parts;
    const legacySource = normalizeSource(rawSource);
    cached = await redis.get(`add:results:${legacySource}:${keyword}`);
    const results = Array.isArray(cached) ? cached : [];
    item = results.find((r) => (r.slug ?? r.mangaUrl ?? r.url) === id);
    selectedSource = normalizeSource(item?.source || legacySource);
  }

  return { cached, item, selectedSource };
}

export default async function handler(req, res) {
  const reqLogger = logApiHit("interactive", req);

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

  const payload = JSON.parse(rawString);
  const { type, data: interactionData } = payload;

  if (type === 1) {
    logApiOk(reqLogger, { status: 200, interactionType: type });
    return res.json({ type: 1 });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id } = interactionData;

    if (custom_id === "select_add_src") {
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
        logApiOk(reqLogger, { status: 200, event: "add_selection_not_found" });
        return res.json({
          type: 4,
          data: { content: "Selected manga not found. Run /add again.", flags: 64 },
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
      const page = parseInt(custom_id.split(":")[1], 10) || 1;
      const { content, components } = await buildWhitelistListResponse(page);
      logApiOk(reqLogger, { status: 200, event: "list_component" });
      return res.json({ type: 7, data: { content, components, flags: 64 } });
    }

    logApiOk(reqLogger, { status: 400, reason: "unknown_component" });
    return res.status(400).json({ error: "Unknown component" });
  }

  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interactionData;
    const handle = commands[name];

    if (!handle) {
      logApiOk(reqLogger, { status: 400, reason: "unknown_command", command: name });
      return res.status(400).json({ error: "Unknown command" });
    }

    if (name === "list") {
      const page = parseInt(options?.[0]?.value, 10) || 1;
      const { content, components } = await buildWhitelistListResponse(page);
      logApiOk(reqLogger, { status: 200, event: "list_command" });
      return res.json({ type: 4, data: { content, components, flags: 64 } });
    }

    logApiOk(reqLogger, { status: 200, event: "command_dispatch", command: name });
    return handle(payload, options, res, redis);
  }

  logApiError(reqLogger, new Error("Unknown interaction type"), { status: 400 });
  res.status(400).json({ error: "Unknown interaction type" });
}
