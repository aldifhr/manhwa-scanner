import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../');

function getAllFiles(dirPath, arrayOfFiles) {
  const files = fs.readdirSync(dirPath);
  arrayOfFiles = arrayOfFiles || [];

  files.forEach(function(file) {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== '.next') {
        arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
      }
    } else {
      if (file.endsWith('.js')) {
        arrayOfFiles.push(path.join(dirPath, "/", file));
      }
    }
  });

  return arrayOfFiles;
}

const allJsFiles = getAllFiles(rootDir);

allJsFiles.forEach(fullPath => {
  let content = fs.readFileSync(fullPath, 'utf8');
  let changed = false;

  // Pattern 1: .../lib/domain/manga.js -> .../lib/domain.js
  const newContent1 = content.replace(/from\s+['"]((?:\.\.\/)+)lib\/domain\/(manga|source|whitelist)\.js['"]/g, 'from "$1lib/domain.js"');
  if (newContent1 !== content) {
    content = newContent1;
    changed = true;
  }

  // Pattern 2: .../domain/manga.js -> .../domain.js
  const newContent2 = content.replace(/from\s+['"]((?:\.\.?\/)+)domain\/(manga|source|whitelist)\.js['"]/g, 'from "$1domain.js"');
  if (newContent2 !== content) {
    content = newContent2;
    changed = true;
  }

  // Pattern 3: dynamic imports in orchestrator.js
  // import("../domain.js") -> import("../domain.js")
  const newContent3 = content.replace(/import\s*\(['"]((?:\.\.?\/)+)domain\/(manga|source|whitelist)\.js['"]\)/g, 'import("$1domain.js")');
  if (newContent3 !== content) {
    content = newContent3;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(fullPath, content);
    console.log(`Updated: ${path.relative(rootDir, fullPath)}`);
  }
});
