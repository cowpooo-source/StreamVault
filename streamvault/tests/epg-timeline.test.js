import { describe, it, expect } from "vitest";
import { msToPx, fmtT, getEPGNow, epgLookup, parseEPGDate, PX_PER_MIN, TOTAL_HOURS, TOTAL_MS, TOTAL_PX, CH_COL_W, ROW_H } from "../src/epg.js";

describe("TimelineGrid constants", () => {
  it("should export PX_PER_MIN", () => {
    expect(PX_PER_MIN).toBe(3);
  });

  it("should export TOTAL_HOURS", () => {
    expect(TOTAL_HOURS).toBe(8);
  });

  it("should calculate TOTAL_MS correctly", () => {
    expect(TOTAL_MS).toBe(8 * 3600000);
  });

  it("should calculate TOTAL_PX correctly", () => {
    expect(TOTAL_PX).toBe(8 * 60 * 3); // 1440px
  });

  it("should export CH_COL_W", () => {
    expect(CH_COL_W).toBe(160);
  });

  it("should export ROW_H", () => {
    expect(ROW_H).toBe(48);
  });
});

describe("msToPx", () => {
  it("should convert milliseconds to pixels", () => {
    const windowStart = 1000000;
    expect(msToPx(1000000 + 60000, windowStart)).toBe(3); // 1 min = 3px
    expect(msToPx(1000000 + 600000, windowStart)).toBe(30); // 10 min = 30px
  });

  it("should return 0 for same time as windowStart", () => {
    const windowStart = 1000000;
    expect(msToPx(1000000, windowStart)).toBe(0);
  });
});

describe("fmtT", () => {
  it("should format milliseconds to time string", () => {
    const ms = new Date("2026-05-03T14:30:00").getTime();
    const result = fmtT(ms);
    expect(result).toMatch(/\d{1,2}:\d{2}\s*[ap]\.?m\.?/i);
  });
});

describe("getEPGNow", () => {
  it("should return correct program for current time", () => {
    const now = Date.now();
    const programs = {
      "ch1": [
        { start: now - 1000, stop: now + 1000, title: "Current" },
        { start: now + 1000, stop: now + 2000, title: "Next" }
      ]
    };
    expect(getEPGNow(programs, "ch1")).toEqual(programs.ch1[0]);
  });

  it("should handle normalized epgId", () => {
    const now = Date.now();
    const programs = {
      "ch1": [{ start: now - 1000, stop: now + 1000, title: "Current" }]
    };
    expect(getEPGNow(programs, "  CH1  ")).toEqual(programs.ch1[0]);
  });

  it("should return null if no program found", () => {
    const now = Date.now();
    const programs = {
      "ch1": [{ start: now + 1000, stop: now + 2000, title: "Next" }]
    };
    expect(getEPGNow(programs, "ch1")).toBeNull();
  });

  it("should return null for empty inputs", () => {
    expect(getEPGNow(null, "ch1")).toBeNull();
    expect(getEPGNow({}, null)).toBeNull();
  });
});

describe("epgLookup", () => {
  const epgData = { "ch.123": [{ title: "Program" }] };
  it("should find by normalized epgId", () => {
    expect(epgLookup(epgData, { epgId: "  CH.123  " })).toBe(epgData["ch.123"]);
  });
  it("should find by raw epgId", () => {
    expect(epgLookup(epgData, { epgId: "ch.123" })).toBe(epgData["ch.123"]);
  });
  it("should find by id", () => {
    const data = { "123": [{ title: "Prog" }] };
    expect(epgLookup(data, { id: "123" })).toBe(data["123"]);
  });
  it("should return null for no match or empty input", () => {
    expect(epgLookup(null, {})).toBeNull();
    expect(epgLookup(epgData, { epgId: "none" })).toBeNull();
  });
});

describe("parseEPGDate", () => {
  it("should parse ISO date", () => {
    const s = "2026-05-03T14:30:00Z";
    expect(parseEPGDate(s)).toBe(new Date(s).getTime());
  });
  it("should parse XMLTV date format YYYYMMDDHHmmss", () => {
    const s = "20260503143000";
    // Date constructor for YYYY, MM (0-indexed), DD, HH, mm, ss
    const expected = new Date(2026, 4, 3, 14, 30, 0).getTime();
    expect(parseEPGDate(s)).toBe(expected);
  });
  it("should return 0 for invalid date", () => {
    expect(parseEPGDate("invalid")).toBe(0);
    expect(parseEPGDate(null)).toBe(0);
  });
});
