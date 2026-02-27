// test-recent.js
import * as recentModule from "../lib/commands/recent.js";
const handleRecent = recentModule.default || recentModule.handleRecent;

// Mock Discord
const mockEdit = async (token, content) => {
  console.log('🧪 MOCK Discord:', typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return { data: 'sent' };
};

const mockRes = { json: (data) => console.log('✅ Vercel:', data) };
const mockPayload = { token: 'test-token' };

global.editInteractionResponse = mockEdit;

handleRecent(mockPayload, {}, mockRes)
  .then(() => console.log('✅ Test OK!'))
  .catch(e => console.error('❌ Error:', e.message));
