import handlePing        from "./ping.js";
import handleList        from "./list.js";
import handleSearch      from "./search.js";
import handleRemove      from "./remove.js";
import handleClear       from "./clear.js";
import handleStatus      from "./status.js";
import handleCheck       from "./check.js";
import handleForcescrape from "./forcescrape.js";
import handleInfo        from "./info.js";
import handleRecent      from "./recent.js";
import handleSetchannel  from "./setchannel.js";
import handlePopular     from "./popular.js";

export default {
  ping:        handlePing,
  list:        handleList,
  search:      handleSearch,
  remove:      handleRemove,
  clear:       handleClear,
  status:      handleStatus,
  check:       handleCheck,
  forcescrape: handleForcescrape,
  info:        handleInfo,
  recent:      handleRecent,
  setchannel:  handleSetchannel,
  popular:     handlePopular,
};
