import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

const cwd = process.cwd();
const envPath = path.join(cwd, ".env");

const TARGET_KEYS = [
  "CRON_SECRET",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_SESSION_SECRET",
];

function randomSecret(bytes = 32) {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function rotateEnvSecrets(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`.env not found at ${filePath}`);
  }

  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split(/\r?\n/);
  const found = new Set<string>();

  const updated = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return line;

    const key = match[1];
    if (!TARGET_KEYS.includes(key)) return line;

    found.add(key);
    return `${key}=${randomSecret(36)}`;
  });

  for (const key of TARGET_KEYS) {
    if (!found.has(key)) {
      updated.push(`${key}=${randomSecret(36)}`);
    }
  }

  const backupPath = `${filePath}.bak.${Date.now()}`;
  fs.writeFileSync(backupPath, original, "utf8");
  fs.writeFileSync(filePath, updated.join("\n"), "utf8");

  return { backupPath, rotatedKeys: TARGET_KEYS };
}

try {
  const result = rotateEnvSecrets(envPath);
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (err: any) {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
