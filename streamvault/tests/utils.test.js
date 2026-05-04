import { describe, it, expect } from "vitest";
import {
  API,
  vastProxyUrl,
  resolveUrl,
  parseVastTime,
  imgSrc,
  mergeTrackers,
  uid,
  fmtTime,
  parseM3U,
  genCSS,
} from "../src/utils.js";

describe("vastProxyUrl", () => {
  it("should wrap URL with proxy endpoint", () => {
    const url = "http://example.com/vast.xml";
    expect(vastProxyUrl(url)).toBe(`${API}/api/vast?url=http%3A%2F%2Fexample.com%2Fvast.xml`);
  });
});

describe("resolveUrl", () => {
  it("should resolve relative URLs against base", () => {
    expect(resolveUrl("/path", "http://example.com")).toBe("http://example.com/path");
    expect(resolveUrl("https://absolute.com", "http://base.com")).toBe("https://absolute.com/");
  });

  it("should return empty string for invalid URLs", () => {
    expect(resolveUrl("", "http://example.com")).toBe("");
    expect(resolveUrl("invalid://url", "http://example.com")).toBe("");
  });
});

describe("parseVastTime", () => {
  it("should parse seconds", () => {
    expect(parseVastTime("30")).toBe(30);
    expect(parseVastTime("0")).toBe(0);
    expect(parseVastTime("")).toBe(0);
  });

  it("should parse MM:SS format", () => {
    expect(parseVastTime("1:30")).toBe(90);
    expect(parseVastTime("0:45")).toBe(45);
  });

  it("should parse HH:MM:SS format", () => {
    expect(parseVastTime("1:30:00")).toBe(5400);
    expect(parseVastTime("0:05:30")).toBe(330);
  });

  it("should return 0 for invalid values", () => {
    expect(parseVastTime("invalid")).toBe(0);
    expect(parseVastTime("abc:def")).toBe(0);
  });
});

describe("imgSrc", () => {
  it("should proxy non-TMDB URLs", () => {
    expect(imgSrc("http://example.com/image.jpg")).toContain("/img?url=");
  });

  it("should not proxy TMDB URLs", () => {
    expect(imgSrc("https://image.tmdb.org/t/p/w500/poster.jpg")).toBe("https://image.tmdb.org/t/p/w500/poster.jpg");
    expect(imgSrc("https://themoviedb.org/image.jpg")).toBe("https://themoviedb.org/image.jpg");
  });

  it("should return null for empty URLs", () => {
    expect(imgSrc(null)).toBeNull();
    expect(imgSrc("")).toBeNull();
  });
});

describe("mergeTrackers", () => {
  it("should merge tracker sets", () => {
    const set1 = { impression: ["url1"], click: ["url2"] };
    const set2 = { impression: ["url3"], complete: ["url4"] };
    const result = mergeTrackers(set1, set2);
    expect(result.impression).toContain("url1");
    expect(result.impression).toContain("url3");
    expect(result.click).toContain("url2");
    expect(result.complete).toContain("url4");
  });

  it("should deduplicate URLs", () => {
    const set = { impression: ["url1", "url1", "url2"] };
    const result = mergeTrackers(set);
    expect(result.impression).toEqual(["url1", "url2"]);
  });

  it("should handle null/undefined sets", () => {
    const result = mergeTrackers(null, { click: ["url1"] }, undefined);
    expect(result.click).toContain("url1");
  });
});

describe("uid", () => {
  it("should return a string", () => {
    const id = uid();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("should return unique IDs", () => {
    const id1 = uid();
    const id2 = uid();
    expect(id1).not.toBe(id2);
  });
});

describe("fmtTime", () => {
  it("should format seconds", () => {
    expect(fmtTime(65)).toBe("1:05");
    expect(fmtTime(0)).toBe("0:00");
  });

  it("should format hours, minutes, seconds", () => {
    expect(fmtTime(3661)).toBe("1:01:01");
  });

  it("should handle null/undefined", () => {
    expect(fmtTime(null)).toBe("0:00");
    expect(fmtTime(undefined)).toBe("0:00");
  });
});

describe("parseM3U", () => {
  it("should parse M3U playlist", () => {
    const text = `#EXTM3U
#EXTINF:-1 tvg-logo="http://example.com/logo.png",Channel 1
http://example.com/stream1
#EXTINF:-1,Channel 2
http://example.com/stream2`;
    const result = parseM3U(text);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("Channel 1");
    expect(result[0].url).toBe("http://example.com/stream1");
    expect(result[1].name).toBe("Channel 2");
  });

  it("should handle empty input", () => {
    expect(parseM3U("")).toEqual([]);
    expect(parseM3U(null)).toEqual([]);
  });
});

describe("genCSS", () => {
  it("should generate CSS variables from theme", () => {
    const theme = {
      "--bg": "#0f0f1c",
      "--accent": "#00d4ff",
      bg: "#0f0f1c",
      accent: "#00d4ff",
      s1: "#1a1a2e",
      s2: "#25253d",
      s3: "#32324d",
      t1: "#ffffff",
      t2: "#e0e0e0",
      t3: "#a0a0a0",
      accent2: "#0099cc",
    };
    const css = genCSS(theme);
    expect(css).toContain("--bg:");
    expect(css).toContain("--accent:");
  });

  it("should return empty string for null theme", () => {
    expect(genCSS(null)).toBe("");
  });
});
