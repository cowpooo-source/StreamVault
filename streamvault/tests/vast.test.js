import { describe, it, expect } from "vitest";
import { collectVastTrackers, fetchVastAd, parseVastDocument } from "../src/vast.js";

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
      querySelector: (sel) => {
        if (sel === "Wrapper" || sel === "InLine") return null;
        return null;
      },
    };
    const result = parseVastDocument(mockDoc, "http://example.com/vast.xml", null, 0, {});
    expect(result).toBeNull();
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
});
