import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

describe("scaffold", () => {
  it("svelte.config exists", () =>
    expect(existsSync("svelte.config.js")).toBe(true));
  it("vite.config exists", () =>
    expect(existsSync("vite.config.ts")).toBe(true));
  it("app.html exists and has sveltekit placeholders", () => {
    const s = readFileSync("src/app.html", "utf8");
    expect(s).toContain("%sveltekit.head%");
    expect(s).toContain("%sveltekit.body%");
  });
  it("app.css merged globals+gold", () => {
    const s = readFileSync("src/app.css", "utf8");
    expect(s).toContain("--gold-surface");
    expect(s).toContain('@import "tailwindcss"');
  });
  it("static assets copied", () => {
    expect(existsSync("static/manifest.json")).toBe(true);
    expect(existsSync("static/icon.svg")).toBe(true);
  });
});
