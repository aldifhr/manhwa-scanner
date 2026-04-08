import { InteractionResponseType } from "discord-interactions";
import handleRemove from "./remove.js";
import handleStatus from "./status.js";
import handleSync from "./sync.js";
import handleAdd from "./add.js";
import handleFollow from "./follow.js";
import handlePermission from "./permission.js";
import {
  handleSetchannel,
  handleMark,
  handleHealth,
  handleList,
} from "./simpleCommands.js";
import { clearWhitelist as handleClear } from "../services/whitelist.js";
import { DISCORD_EPHEMERAL_FLAG } from "../config.js";

export default {
  remove: handleRemove,
  status: handleStatus,
  sync: handleSync,
  setchannel: handleSetchannel,
  add: handleAdd,
  mark: handleMark,
  follow: handleFollow,
  health: handleHealth,
  list: handleList,
  permission: handlePermission,
  clear: async (payload, options, res) => {
    if (!(await import("../permissions.js").then((m) => m.isOwner(payload)))) {
      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Hanya owner bot yang bisa menghapus seluruh whitelist.",
          flags: DISCORD_EPHEMERAL_FLAG,
        },
      });
    }
    const result = await handleClear();
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `✅ Whitelist berhasil dikosongkan (Total **${result.count}** manga dihapus).`,
        flags: DISCORD_EPHEMERAL_FLAG,
      },
    });
  },
};
