import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../');

const filesToUpdate = [
  'tests/whitelist-service.test.js',
  'tests/scraper-dispatch.integration.test.js',
  'tests/domain-whitelist.test.js',
  'tests/domain-source.test.js',
  'tests/domain-manga.test.js',
  'scripts/format-whitelist.js',
  'lib/services/whitelist.js',
  'lib/services/staleChecker.js',
  'lib/services/scrapePreferences.js',
  'lib/services/dispatch.js',
  'lib/services/commandDispatchFlow.js',
  'lib/scrapers/shared.js',
  'lib/scrapers/orchestrator.js',
  'lib/redis.js',
  'lib/cronRuntime.js',
  'lib/commands/sync.js',
  'lib/commands/status.js',
  'lib/commands/remove.js',
  'lib/commands/myprogress.js',
  'lib/commands/mark.js',
  'lib/commands/add.js',
  'api/interactive.js'
];

filesToUpdate.forEach(relPath => {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`Skipping missing file: ${relPath}`);
    return;
  }

  let content = fs.readFileSync(fullPath, 'utf8');
  
  // Replace ../domain/manga.js, ./domain/source.js, etc. with ../domain.js or ./domain.js
  // Adjust based on nesting depth.
  
  const depth = relPath.split('/').length - 1;
  const newImportPath = depth > 0 ? '../'.repeat(depth) + 'domain.js' : './domain.js';
  
  // Regex to match imports from domain directory
  const regex = /from\s+['"](?:\.\.?\/)+domain\/(?:manga|source|whitelist)\.js['"]/g;
  
  // Note: This is a bit tricky because some files might import from different depths.
  // Let's use a more precise replacement.
  
  content = content.replace(/from\s+['"](\.\.?\/)+domain\/(manga|source|whitelist)\.js['"]/g, (match, p1) => {
    // If it was ../../domain/manga.js, it should become ../../domain.js
    return `from "${p1}domain.js"`;
  });

  fs.writeFileSync(fullPath, content);
  console.log(`Updated: ${relPath}`);
});
