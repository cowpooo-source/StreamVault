import { describe, it, expect } from "vitest";
import { msToPx, fmtT, PX_PER_MIN, TOTAL_HOURS, TOTAL_MS, TOTAL_PX, CH_COL_W, ROW_H } from "../src/epg.js";

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
