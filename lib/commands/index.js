import handleRemove      from "./remove.js";
import handleStatus      from "./status.js";
import handleSync        from "./sync.js";
import handleSetchannel  from "./setchannel.js";
import handleAdd         from "./add.js";
import handleMark        from "./mark.js";
import handleMyProgress  from "./myprogress.js";
import handleRandom      from "./random.js";
import handlePref        from "./pref.js";

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
};
