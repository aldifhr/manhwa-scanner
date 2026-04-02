import { resolve } from "path";
import { fileURLToPath } from "url";
import { readdirSync, statSync, readFileSync } from "fs";

const root = resolve(fileURLToPath(import.meta.url), "../..");

function getAllJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "archive") {
      results.push(...getAllJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

// Only check files that actually use import/require
function hasImports(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    return /^import\s/m.test(content);
  } catch {
    return false;
  }
}

const dirs = ["lib", "api", "scripts"].map(d => resolve(root, d));
const allFiles = dirs.flatMap(getAllJsFiles).filter(hasImports);

console.log(`\nChecking ${allFiles.length} files with imports...\n`);

let passed = 0;
let failed = 0;
const errors = [];

async function checkAll() {
  for (const f of allFiles) {
    const rel = f.replace(root + "\\", "").replace(/\\/g, "/");
    try {
      await import(`file:///${f.replace(/\\/g, "/")}`);
      console.log(`✔ ${rel}`);
      passed++;
    } catch (e) {
      console.error(`✖ ${rel}\n  → ${e.message}\n`);
      errors.push({ rel, msg: e.message });
      failed++;
    }
  }

  console.log("\n============================");
  console.log(`✔ PASS: ${passed}  ✖ FAIL: ${failed}`);
  console.log("============================");
  if (errors.length) {
    console.log("\nFailed files:");
    for (const { rel, msg } of errors) {
      console.log(` - ${rel}: ${msg}`);
    }
  }
}

checkAll();
