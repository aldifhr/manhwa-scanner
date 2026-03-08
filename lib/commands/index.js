import handlePing        from "./ping.js";
import handleList        from "./list.js";
import handleRemove      from "./remove.js";
import handleClear       from "./clear.js";
import handleStatus      from "./status.js";
import handleCheck       from "./check.js";
import handleSetchannel  from "./setchannel.js";
import handleAdd         from "./add.js";
import handleResync24h   from "./resync24h.js";

export default {
  ping:        handlePing,
  list:        handleList,
  remove:      handleRemove,
  clear:       handleClear,
  status:      handleStatus,
  check:       handleCheck,
  setchannel:  handleSetchannel,
  add:         handleAdd,
  resync24h:   handleResync24h,
};
