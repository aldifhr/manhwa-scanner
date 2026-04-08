import handleRemove from "./remove.js";
import handleStatus from "./status.js";
import handleSync from "./sync.js";
import handleAdd from "./add.js";
import handleFollow from "./follow.js";
import handlePermission from "./permission.js";
import {
  handleSetchannel,
  handleMark,
  handlePref,
  handleHealth,
  handleList,
} from "./simpleCommands.js";
import { clearWhitelist as handleClear } from "../services/whitelist.js";

export default {
  remove: handleRemove,
  status: handleStatus,
  sync: handleSync,
  setchannel: handleSetchannel,
  add: handleAdd,
  mark: handleMark,
  follow: handleFollow,
  pref: handlePref,
  health: handleHealth,
  list: handleList,
  permission: handlePermission,
  clear: async (payload, options, res) => {
    if (!(await import("../permissions.js").then((m) => m.isOwner(payload)))) {
      return res.json({
        type: 4,
        data: {
          content: "Hanya owner bot yang bisa menghapus seluruh whitelist.",
          flags: 64,
        },
      });
    }
    const result = await handleClear();
    return res.json({
      type: 4,
      data: {
        content: `✅ Whitelist berhasil dikosongkan (Total **${result.count}** manga dihapus).`,
        flags: 64,
      },
    });
  },
};
