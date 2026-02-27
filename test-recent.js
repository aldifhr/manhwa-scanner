// test-recent.js
import { handleRecent } from "./lib/commands/recent.js";

const mockRes = {
  json: (data) => console.log('✅ Response sent:', data)
};

const mockPayload = { token: 'test-token' };

handleRecent(mockPayload, {}, mockRes)
  .then(() => console.log('✅ Test complete!'))
  .catch(console.error);