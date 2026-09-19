#!/usr/bin/env node
// cross-platform backend runner: uses `py -3` on Windows, `python3`/`python` on Linux/Mac, fallback to `uv`
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const appDir = resolve(root, "apps/backend");

const isWin = process.platform === "win32";
const candidates = isWin
  ? [
      ["py", ["-3", "-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]],
      ["python", ["-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]],
      ["uv", ["run", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]],
    ]
  : [
      ["uv", ["run", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]],
      ["python3", ["-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]],
      ["python", ["-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"]],
    ];

function trySpawn(idx = 0) {
  if (idx >= candidates.length) {
    console.error("No python/uv found to run backend. Install Python 3.11+ and uv, or run manually: py -3 -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --app-dir apps/backend");
    process.exit(1);
  }
  const [cmd, args] = candidates[idx];
  const child = spawn(cmd, args, { stdio: "inherit", shell: false, cwd: appDir });
  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.warn(`[dev:backend] ${cmd} not found, trying next...`);
      trySpawn(idx + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

trySpawn();
