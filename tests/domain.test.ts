import { describe, it, expect } from "vitest";
import {
  normalizeTitleKey,
  isSameNormalizedTitle,
  fuzzyTitleSimilarity,
  normalizeSourceUrl,
  inferSourceFromUrl,
} from "../lib/domain.js";

describe("Domain Helpers", () => {
  describe("normalizeTitleKey", () => {
    it("should normalize title case and whitespace", () => {
      expect(normalizeTitleKey("  Solo   Leveling  ")).toBe("solo leveling");
    });

    it("should remove special characters", () => {
      expect(normalizeTitleKey("No.1 Player's Return!")).toBe("no1 players return");
    });
  });

  describe("isSameNormalizedTitle", () => {
    it("should identify match ignoring spaces/casing", () => {
      expect(isSameNormalizedTitle("Juru Masak Dungeon", "juru-masak-dungeon")).toBe(true);
    });

    it("should return false for different titles", () => {
      expect(isSameNormalizedTitle("Ikiru wtf", "Shinigami asia")).toBe(false);
    });
  });

  describe("fuzzyTitleSimilarity", () => {
    it("should return 1 for exact match", () => {
      expect(fuzzyTitleSimilarity("test", "test")).toBe(1.0);
    });

    it("should calculate correct similarity", () => {
      const score = fuzzyTitleSimilarity("Solo Leveling", "Solo Leveling (Official)");
      expect(score).toBeGreaterThan(0.7);
    });
  });

  describe("normalizeSourceUrl", () => {
    it("should format subdomain urls correctly", () => {
      expect(normalizeSourceUrl("http://shinigami.asia/series/manga-abc")).toBe("https://g.shinigami.asia/series/manga-abc/");
    });
  });

  describe("inferSourceFromUrl", () => {
    it("should infer correct source from url", () => {
      expect(inferSourceFromUrl("https://g.shinigami.asia/series/abc")).toBe("shinigami");
      expect(inferSourceFromUrl("https://05.ikiru.wtf/manga/abc")).toBe("ikiru");
    });
  });
});
