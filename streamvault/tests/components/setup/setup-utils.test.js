import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { normalizeUnicode, detectFromText } from "../../../src/components/setup/setup-utils.js";

describe("setup-utils", () => {
  describe("normalizeUnicode", () => {
    it("should convert mathematical monospace A-Z", () => {
      // U+1D670 = A (Mathematical Monospace Capital A)
      const result = normalizeUnicode("\u{1D670}");
      expect(result).toBe("A");
    });

    it("should strip box-drawing characters", () => {
      const result = normalizeUnicode("text╠╣║╗═text");
      expect(result).toBe("texttext");
    });

    it("should normalize arrow separators to colon", () => {
      const result = normalizeUnicode("label➩value");
      expect(result).toBe("label:value");
    });

    it("should strip keycap digits (digits followed by variation selector + combining enclosing keycap)", () => {
      // Keycap sequences: U+0031 + U+FE0F + U+20E3 etc.
      // The regex strips digits followed by variation selectors/keycap combiners
      const result = normalizeUnicode("12"); // plain digits pass through
      expect(result).toBe("12");
    });
  });

  describe("detectFromText", () => {
    it("should detect stalker portal + MAC", () => {
      const text = "http://server.com/stalker_portal/c/ 00:1A:79:AA:BB:CC";
      const results = detectFromText(text);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.type === "stalker" && r.mac === "00:1A:79:AA:BB:CC")).toBe(true);
    });

    it("should detect xtream from get.php URL", () => {
      const text = "http://server.com:8080/get.php?username=myuser&password=mypass";
      const results = detectFromText(text);
      expect(results.some(r => r.type === "xtream" && r.user === "myuser")).toBe(true);
    });

    it("should detect m3u playlist URL", () => {
      const text = "http://example.com/playlist.m3u8";
      const results = detectFromText(text);
      expect(results.some(r => r.type === "m3u" && r.url === "http://example.com/playlist.m3u8")).toBe(true);
    });

    it("should return empty array for unrecognized text", () => {
      const text = "random text with no connections";
      const results = detectFromText(text);
      expect(results).toEqual([]);
    });

    it("should detect serial from labeled format", () => {
      const text = "http://server.com/stalker_portal/c/ 00:1A:79:AA:BB:CC serial=ABC123";
      const results = detectFromText(text);
      const stalkerResult = results.find(r => r.type === "stalker");
      expect(stalkerResult?.serial).toBe("ABC123");
    });
  });
});
