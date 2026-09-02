import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendOpenapi = path.resolve(__dirname, "../../apps/backend/openapi.json");
const sharedOpenapi = path.resolve(__dirname, "../openapi.json");
const schemasPath = path.resolve(__dirname, "../src/schemas.ts");

if (fs.existsSync(backendOpenapi)) {
  fs.copyFileSync(backendOpenapi, sharedOpenapi);
  console.log("generate: copied apps/backend/openapi.json -> packages/shared/openapi.json");
} else {
  console.warn("generate: backend openapi not found, skip copy");
}

// Validate schemas.ts exists and re-export is wired
if (fs.existsSync(schemasPath)) {
  console.log("generate: schemas.ts present (zod dual snake/camel helpers)");
} else {
  console.warn("generate: schemas.ts missing");
}

// Touch index.ts to ensure re-export
const indexPath = path.resolve(__dirname, "../src/index.ts");
let idx = fs.readFileSync(indexPath, "utf8");
if (!idx.includes('from "./schemas')) {
  idx = idx.replace(
    'export default openapi;',
    'export default openapi;\nexport * from "./schemas.js";'
  );
  fs.writeFileSync(indexPath, idx);
  console.log("generate: wired schemas export in index.ts");
}

console.log("generate: done — FE can now import { excludedTitleSchema } from '@manhwa-scanner/shared'");
