import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../');

const filesToUpdate = [
  'lib/services/dispatch.js',
  'lib/commands/sync.js',
  'lib/commands/status.js',
  'lib/api/getEndpoint.js'
];

filesToUpdate.forEach(relPath => {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) return;

  let content = fs.readFileSync(fullPath, 'utf8');
  
  // Replace consts.js and runtimeConfig.js with config.js
  content = content.replace(/from\s+['"](?:\.\.\/|\.\/)+(?:consts|runtimeConfig)\.js['"]/g, match => {
     const depth = match.includes('../') ? (match.match(/\.\.\//g) || []).length : 0;
     const prefix = depth > 0 ? '../'.repeat(depth) : './';
     return `from "${prefix}config.js"`;
  });
  
  // Hande multiple imports from both files in the same file
  // (If there were two lines, they might both now point to config.js)
  // Let's do a simple cleanup for duplicate imports from config.js
  const lines = content.split('\n');
  const uniqueLines = [];
  const configImportIndices = [];
  
  lines.forEach((line, idx) => {
    if (line.includes('from') && line.includes('config.js') && line.includes('import')) {
       configImportIndices.push(idx);
    }
  });

  if (configImportIndices.length > 1) {
    // Merge them: collect all named exports
    const namedExports = [];
    configImportIndices.forEach(idx => {
       const match = lines[idx].match(/import\s*\{([^}]+)\}/);
       if (match) {
         match[1].split(',').forEach(s => namedExports.push(s.trim()));
       }
    });
    
    const uniqueExports = [...new Set(namedExports)].filter(Boolean);
    const newImportLine = `import { ${uniqueExports.join(', ')} } from "${lines[configImportIndices[0]].match(/from\s+['"]([^'"]+)['"]/)[1]}";`;
    
    // Remove all old import lines and insert the new one at the first index
    let offset = 0;
    configImportIndices.forEach(idx => {
       lines.splice(idx - offset, 1);
       offset++;
    });
    lines.splice(configImportIndices[0], 0, newImportLine);
    content = lines.join('\n');
  }

  fs.writeFileSync(fullPath, content);
  console.log(`Updated: ${relPath}`);
});
