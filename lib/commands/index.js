import handlePing        from "./ping.js";
import handleRemove      from "./remove.js";
import handleClear       from "./clear.js";
import handleStatus      from "./status.js";
import handleCheck       from "./check.js";
import handleSetchannel  from "./setchannel.js";
import handleAdd         from "./add.js";
import handleMark        from "./mark.js";
import handleResync24h   from "./resync24h.js";
import handleHealth      from "./health.js";
import handleMyProgress  from "./myprogress.js";

export default {
  ping:        handlePing,
  remove:      handleRemove,
  clear:       handleClear,
  status:      handleStatus,
  check:       handleCheck,
  setchannel:  handleSetchannel,
  add:         handleAdd,
  mark:        handleMark,
  resync24h:   handleResync24h,
  health:      handleHealth,
  myprogress:  handleMyProgress,
};
