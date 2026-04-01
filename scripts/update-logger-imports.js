import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../');

const filesToUpdate = [
  'api/whitelist.js',
  'api/status.js',
  'api/interactive.js',
  'api/history.js',
  'api/health.js',
  'api/cron.js'
];

filesToUpdate.forEach(relPath => {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) return;

  let content = fs.readFileSync(fullPath, 'utf8');
  
  // Replace ../lib/requestLog.js with ../lib/logger.js
  content = content.replace(/from\s+['"](?:\.\.\/)+lib\/requestLog\.js['"]/g, 'from "../lib/logger.js"');
  
  // Also handle cases where logger.js is already imported separately
  // If both exist, we need to merge them.
  
  // For these files, they usually only import logApiHit, logApiOk, logApiError.
  
  fs.writeFileSync(fullPath, content);
  console.log(`Updated: ${relPath}`);
});
