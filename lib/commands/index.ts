import { InteractionResponseType } from "discord-interactions";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";
import { RedisClient } from "../types.js";
import { Response } from "express";

export type CommandHandler = (
  payload: any,
  options: any,
  res: Response,
  redis: RedisClient
) => Promise<any> | any;

const commands: Record<string, () => Promise<CommandHandler>> = {
  remove: () => import("./remove.js").then(m => m.default),
  status: () => import("./status.js").then(m => m.default),
  sync: () => import("./sync.js").then(m => m.default),
  setchannel: () => import("./simpleCommands.js").then(m => m.handleSetchannel),
  add: () => import("./add.js").then(m => m.default),
  follow: () => import("./follow.js").then(m => m.default),
  list: () => import("./simpleCommands.js").then(m => m.handleList),
  permission: () => import("./permission.js").then(m => m.default),
  clear: () => Promise.resolve(async (payload: any, _options: any, res: any) => {
    const { isOwner } = await import("../permissions.js");
    if (!isOwner(payload)) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Hanya owner bot yang bisa menghapus seluruh whitelist.",
          flags: DISCORD_EPHEMERAL_FLAG,
        },
      });
    }
    const { clearWhitelist } = await import("../services/whitelist.js");
    const result = await clearWhitelist();
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `✅ Whitelist berhasil dikosongkan (Total **${result.count}** manga dihapus).`,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  }),
};

export default commands;

