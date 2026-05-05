import { describe, it, expect, vi } from "vitest";
import { collectVastTrackers, fetchVastAd, parseVastDocument } from "../src/vast.js";
import { parseVastTime } from "../src/utils.js";
import * as utils from "../src/utils.js";

describe("parseVastTime", () => {
  it("should parse HH:MM:SS format", () => {
    expect(parseVastTime("00:00:10")).toBe(10);
    expect(parseVastTime("01:02:03")).toBe(3600 + 120 + 3);
  });
  it("should parse MM:SS format", () => {
    expect(parseVastTime("02:03")).toBe(123);
  });
  it("should parse seconds as number string", () => {
    expect(parseVastTime("15")).toBe(15);
  });
  it("should return 0 for invalid or empty", () => {
    expect(parseVastTime(null)).toBe(0);
    expect(parseVastTime("")).toBe(0);
    expect(parseVastTime("abc")).toBe(0);
    expect(parseVastTime("12:abc:34")).toBe(0);
  });
});

describe("collectVastTrackers", () => {
  it("should collect impression trackers", async () => {
    const mockRoot = {
      querySelectorAll: (sel) => {
        if (sel === "Impression") {
          return [{ textContent: "http://example.com/impression" }];
        }
        return [];
      },
    };
    const trackers = await collectVastTrackers(mockRoot);
    expect(trackers.impression).toContain("http://example.com/impression");
  });

  it("should collect event trackers", async () => {
    const mockRoot = {
      querySelectorAll: (sel) => {
        if (sel === "TrackingEvents Tracking") {
          return [{
            getAttribute: () => "start",
            textContent: "http://example.com/start",
          }];
        }
        return [];
      },
    };
    const trackers = await collectVastTrackers(mockRoot);
    expect(trackers.start).toContain("http://example.com/start");
  });

  it("should return empty object for no trackers", async () => {
    const mockRoot = {
      querySelectorAll: () => [],
    };
    const trackers = await collectVastTrackers(mockRoot);
    expect(trackers).toEqual({});
  });
});

describe("parseVastDocument", () => {
  it("should return null for non-Vast documents", () => {
    const mockDoc = {
      querySelector: (_sel) => null,
    };
    const result = parseVastDocument(mockDoc, "http://example.com/vast.xml", null, 0, {});
    expect(result).toBeNull();
  });

  it("should parse a basic InLine ad", () => {
    const xml = `
      <VAST version="3.0">
        <Ad>
          <InLine>
            <AdTitle>Test Ad</AdTitle>
            <Impression>http://example.com/imp</Impression>
            <Creatives>
              <Creative>
                <Linear skipoffset="00:00:05">
                  <Duration>00:00:30</Duration>
                  <VideoClicks>
                    <ClickThrough>http://example.com/click</ClickThrough>
                  </VideoClicks>
                  <MediaFiles>
                    <MediaFile type="video/mp4">http://example.com/video.mp4</MediaFile>
                  </MediaFiles>
                </Linear>
              </Creative>
            </Creatives>
          </InLine>
        </Ad>
      </VAST>
    `;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const result = parseVastDocument(doc, "http://base.com/vast.xml", null, 0, {});
    
    expect(result.title).toBe("Test Ad");
    expect(result.mediaUrl).toBe("http://example.com/video.mp4");
    expect(result.duration).toBe(30);
    expect(result.skipOffset).toBe(5);
    expect(result.trackers.impression).toContain("http://example.com/imp");
  });

  it("should return null if no media files", () => {
     const xml = `<VAST><Ad><InLine><Linear><MediaFiles></MediaFiles></Linear></InLine></Ad></VAST>`;
     const doc = new DOMParser().parseFromString(xml, "application/xml");
     expect(parseVastDocument(doc, "http://base.com/vast.xml", null, 0, {})).toBeNull();
  });

  it("should select best media file type", () => {
    const xml = `
      <VAST>
        <Ad>
          <InLine>
            <Linear>
              <MediaFiles>
                <MediaFile type="application/x-mpegURL">http://example.com/playlist.m3u8</MediaFile>
                <MediaFile type="video/mp4">http://example.com/video.mp4</MediaFile>
              </MediaFiles>
            </Linear>
          </InLine>
        </Ad>
      </VAST>
    `;
    const videoEl = {
      canPlayType: (type) => type === "video/mp4" ? "probably" : "",
    };
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const result = parseVastDocument(doc, "http://base.com/vast.xml", videoEl, 0, {});
    expect(result.mediaUrl).toBe("http://example.com/video.mp4");
    expect(result.mediaType).toBe("video/mp4");
  });
});

describe("fetchVastAd", () => {
  it("should return null for empty URL", async () => {
    const result = await fetchVastAd(null, null, 0, {});
    expect(result).toBeNull();
  });

  it("should return null when depth > 2", async () => {
    const result = await fetchVastAd("http://example.com/vast.xml", null, 3, {});
    expect(result).toBeNull();
  });

  it("should follow Wrappers", async () => {
    const wrapperXml = `
      <VAST>
        <Ad>
          <Wrapper>
            <VASTAdTagURI><![CDATA[http://example.com/inline.xml]]></VASTAdTagURI>
          </Wrapper>
        </Ad>
      </VAST>
    `;
    const inlineXml = `
      <VAST>
        <Ad>
          <InLine>
            <AdTitle>Final Ad</AdTitle>
            <Linear>
              <Duration>00:00:15</Duration>
              <MediaFiles><MediaFile type="video/mp4">http://example.com/video.mp4</MediaFile></MediaFiles>
            </Linear>
          </InLine>
        </Ad>
      </VAST>
    `;

    const fetchSpy = vi.spyOn(utils, "fetchTextWithTimeout").mockImplementation(async (url) => {
      if (url.includes("wrapper")) return wrapperXml;
      if (url.includes("inline")) return inlineXml;
      return null;
    });

    const result = await fetchVastAd("http://example.com/wrapper.xml", null);
    expect(result.mediaUrl).toBe("http://example.com/video.mp4");
    expect(result.title).toBe("Final Ad");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    
    fetchSpy.mockRestore();
  });

  it("should return null on fetch failure", async () => {
    const fetchSpy = vi.spyOn(utils, "fetchTextWithTimeout").mockResolvedValue("");
    const result = await fetchVastAd("http://example.com/fail.xml", null);
    expect(result).toBeNull();
    fetchSpy.mockRestore();
  });

  it("should handle parsererror by trying proxy", async () => {
    const badXml = "<invalid></invalid>";
    const goodXml = `
      <VAST><Ad><InLine><Linear><Duration>10</Duration>
        <MediaFiles><MediaFile>http://proxy.com/v.mp4</MediaFile></MediaFiles>
      </Linear></InLine></Ad></VAST>`;
    
    const fetchSpy = vi.spyOn(utils, "fetchTextWithTimeout").mockImplementation(async (url) => {
      if (url.includes("api/vast")) return goodXml;
      return badXml;
    });

    // Mock DOMParser to return a parsererror for the first call
    const realParseFromString = DOMParser.prototype.parseFromString;
    let callCount = 0;
    vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(function(str, type) {
      callCount++;
      if (callCount === 1) {
        return {
          querySelector: (sel) => sel === "parsererror" ? {} : null
        };
      }
      return realParseFromString.call(this, str, type);
    });

    const result = await fetchVastAd("http://example.com/bad.xml", null);
    expect(result.mediaUrl).toBe("http://proxy.com/v.mp4");
    
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
