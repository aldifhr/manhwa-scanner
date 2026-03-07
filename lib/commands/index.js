import handlePing        from "./ping.js";
import handleList        from "./list.js";
import handleRemove      from "./remove.js";
import handleClear       from "./clear.js";
import handleStatus      from "./status.js";
import handleCheck       from "./check.js";
import handleSetchannel  from "./setchannel.js";
import handleAdd         from "./add.js";

export default {
  ping:        handlePing,
  list:        handleList,
  remove:      handleRemove,
  clear:       handleClear,
  status:      handleStatus,
  check:       handleCheck,
  setchannel:  handleSetchannel,
  add:         handleAdd,
};
