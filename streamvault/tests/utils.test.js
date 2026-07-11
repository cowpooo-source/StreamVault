import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  validateM3UChunk,
  genCSS,
  streamProxy,
} from "../src/utils.js";

describe("streamProxy", () => {
  it("should return relative URLs as is", () => {
    expect(streamProxy("/local/path")).toBe("/local/path");
  });

  it("should return URLs matching origin as is", () => {
    // In tests, API is "" so origin is location.origin
    const origin = location.origin;
    expect(streamProxy(`${origin}/stream`)).toBe(`${origin}/stream`);
  });

  it("should proxy external URLs", () => {
    const url = "http://external.com/stream.m3u8";
    expect(streamProxy(url)).toBe(`${API}/stream?url=${encodeURIComponent(url)}`);
  });
});

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
  it("should parse M3U playlist with full metadata", () => {
    const text = `#EXTM3U url-tvg="http://example.com/epg.xml"
#EXTINF:-1 tvg-id="ch1" tvg-logo="http://example.com/logo1.png" group-title="Entertainment" tvg-chno="1",Channel 1
http://example.com/live/1
#EXTINF:-1,VOD Movie
http://example.com/movie/123.mp4
#EXTINF:-1,Series Episode
http://example.com/series/456.mp4`;
    const result = parseM3U(text);
    expect(result.length).toBe(3);
    expect(result.epgUrls).toEqual(["http://example.com/epg.xml"]);

    expect(result[0]).toMatchObject({      name: "Channel 1",
      logo: "http://example.com/logo1.png",
      group: "Entertainment",
      epgId: "ch1",
      num: 1,
      type: "live"
    });

    expect(result[1].type).toBe("vod");
    expect(result[2].type).toBe("series");
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

// Helper to build a Response with a streaming body reader.
function makeStreamResponse(text, { status = 200, byteChunkSize = 16 } = {}) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + byteChunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() {
      // Simulates cancelling the remaining stream after maxBytes read.
    },
  });
  return new Response(stream, { status });
}

describe("validateM3UChunk", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should accept a valid M3U chunk without downloading the full playlist", async () => {
    // Deliberately short chunk (well under the 64KB default) still validates.
    const chunk = "#EXTM3U\n#EXTINF:-1,Chan\nhttp://example.com/live/1";
    fetch.mockResolvedValueOnce(makeStreamResponse(chunk));
    const result = await validateM3UChunk("http://example.com/playlist.m3u");
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("should reject a response that is not an M3U playlist", async () => {
    fetch.mockResolvedValueOnce(makeStreamResponse("<html>not a playlist</html>"));
    const result = await validateM3UChunk("http://example.com/bad");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Not a valid M3U");
  });

  it("should reject a playlist with no channels", async () => {
    fetch.mockResolvedValueOnce(makeStreamResponse("#EXTM3U\n#PLAYLIST:1\n#EXT-X-VERSION:3"));
    const result = await validateM3UChunk("http://example.com/empty");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no channels");
  });

  it("should report HTTP errors", async () => {
    fetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    const result = await validateM3UChunk("http://example.com/missing");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("HTTP 404");
  });

  it("should abort on timeout and report a useful error", async () => {
    const neverResolves = new Promise((_resolve, reject) => {
      // Reject when the abort signal fires, simulating a real fetch abort.
      const check = setInterval(() => {
        if (fetch.mock.calls.length && fetch.mock.calls[0][1]?.signal?.aborted) {
          clearInterval(check);
          reject(new DOMException("Aborted", "AbortError"));
        }
      }, 5);
    });
    fetch.mockReturnValueOnce(neverResolves);
    const result = await validateM3UChunk("http://example.com/slow", { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("timed out");
  });

  it("should not inspect markers beyond the configured byte limit", async () => {
    const delayedMarker = `#EXTM3U\n${"#".repeat(2048)}\n#EXTINF:-1,Too Late\nhttp://example.com/live/1`;
    fetch.mockResolvedValueOnce(makeStreamResponse(delayedMarker, { byteChunkSize: 4096 }));
    const result = await validateM3UChunk("http://example.com/large.m3u", { maxBytes: 1024 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no channels");
  });

  it("should distinguish caller cancellation from timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    fetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const result = await validateM3UChunk("http://example.com/cancelled.m3u", { signal: controller.signal });
    expect(result).toEqual({ ok: false, reason: "Playlist validation cancelled" });
  });
});
