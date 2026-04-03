import handleRemove      from "./remove.js";
import handleStatus      from "./status.js";
import handleSync        from "./sync.js";
import handleSetchannel  from "./setchannel.js";
import handleAdd         from "./add.js";
import handleMark        from "./mark.js";
import handleMyProgress  from "./myprogress.js";
import handleRandom      from "./random.js";
import handlePref        from "./pref.js";
import handleHealth      from "./health.js";
import handleList        from "./list.js";
import { clearWhitelist as handleClear } from "../services/whitelist.js";

export default {
  remove:      handleRemove,
  status:      handleStatus,
  sync:        handleSync,
  setchannel:  handleSetchannel,
  add:         handleAdd,
  mark:        handleMark,
  myprogress:  handleMyProgress,
  random:      handleRandom,
  pref:        handlePref,
  check:       handleSync,      // Alias untuk Quick Sync
  health:      handleHealth,    // Full Audit
  resync24h:   handleSync,      // Deep Sync (ditangani di sync.js)
  list:        handleList,
  search:      handleList,
  clear:       async (payload, options, res) => {
    if (!(await import("../permissions.js").then(m => m.isOwner(payload)))) {
      return res.json({ type: 4, data: { content: "Hanya owner bot yang bisa menghapus seluruh whitelist.", flags: 64 } });
    }
    const result = await handleClear();
    return res.json({ type: 4, data: { content: `✅ Whitelist berhasil dikosongkan (Total **${result.count}** manga dihapus).`, flags: 64 } });
  }
};
