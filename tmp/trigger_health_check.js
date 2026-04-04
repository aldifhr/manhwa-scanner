import { performFullHealthCheck } from './lib/services/health.js';

async function run() {
  console.log('Starting full health check...');
  const brokenLinks = await performFullHealthCheck();
  console.log(`Full health check complete. Found ${brokenLinks.length} broken links.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Error during health check:', err);
  process.exit(1);
});
