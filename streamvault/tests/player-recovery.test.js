import { describe, it, expect } from "vitest";
import {
  canStalkerRefresh,
  canStallRecover,
  chooseStallAction,
  classifyRecoveryPath,
} from "../src/player-recovery.js";

describe("canStalkerRefresh", () => {
  it("allows refresh for a direct Stalker channel with no recent activity", () => {
    const result = canStalkerRefresh(
      { stalkerRefreshInFlight: false, stalkerRefreshTimes: [] },
      { _direct: true },
    );
    expect(result.allowed).toBe(true);
  });

  it("rejects refresh when the channel is not direct", () => {
    const result = canStalkerRefresh(
      { stalkerRefreshInFlight: false },
      { _direct: false },
    );
    expect(result).toEqual({ allowed: false, reason: "not_direct" });
  });

  it("rejects refresh when undefined _direct", () => {
    const result = canStalkerRefresh({ stalkerRefreshInFlight: false }, {});
    expect(result).toEqual({ allowed: false, reason: "not_direct" });
  });

  it("rejects refresh when one is already in flight", () => {
    const result = canStalkerRefresh(
      { stalkerRefreshInFlight: true, stalkerRefreshTimes: [] },
      { _direct: true },
    );
    expect(result).toEqual({ allowed: false, reason: "already_in_flight" });
  });

  it("rejects refresh when max refreshes per window are exceeded", () => {
    const now = Date.now();
    const times = [
      now - 10_000,
      now - 20_000,
      now - 30_000,
    ];
    const result = canStalkerRefresh(
      { stalkerRefreshInFlight: false, stalkerRefreshTimes: times },
      { _direct: true },
    );
    expect(result).toEqual({ allowed: false, reason: "rate_limited" });
  });

  it("allows refresh when some old refreshes have fallen outside the window", () => {
    const now = Date.now();
    const times = [
      now - 10_000,
      now - 61_000, // outside 60s window
    ];
    const result = canStalkerRefresh(
      { stalkerRefreshInFlight: false, stalkerRefreshTimes: times },
      { _direct: true },
    );
    expect(result.allowed).toBe(true);
  });

  it("handles undefined stalkerRefreshTimes gracefully", () => {
    const result = canStalkerRefresh(
      { stalkerRefreshInFlight: false },
      { _direct: true },
    );
    expect(result.allowed).toBe(true);
  });
});

describe("canStallRecover", () => {
  it("allows recovery when all conditions are met", () => {
    expect(
      canStallRecover(
        { recoveryInFlight: false, stall: 0 },
        false, // not ended
        false, // not paused
        "content",
      ).allowed,
    ).toBe(true);
  });

  it("rejects when recovery is already in flight", () => {
    expect(
      canStallRecover({ recoveryInFlight: true, stall: 0 }, false, false, "content"),
    ).toEqual({ allowed: false, reason: "already_in_flight" });
  });

  it("rejects when video has ended", () => {
    expect(
      canStallRecover({ recoveryInFlight: false, stall: 0 }, true, false, "content"),
    ).toEqual({ allowed: false, reason: "video_ended" });
  });

  it("rejects when video is paused", () => {
    expect(
      canStallRecover({ recoveryInFlight: false, stall: 0 }, false, true, "content"),
    ).toEqual({ allowed: false, reason: "video_paused" });
  });

  it("rejects when playback phase is not content", () => {
    expect(
      canStallRecover({ recoveryInFlight: false, stall: 0 }, false, false, "loading"),
    ).toEqual({ allowed: false, reason: "not_content_phase" });
  });

  it("rejects when max stalls reached", () => {
    expect(
      canStallRecover({ recoveryInFlight: false, stall: 3 }, false, false, "content"),
    ).toEqual({ allowed: false, reason: "max_stalls_reached" });
  });

  it("treats stall > 3 as max reached", () => {
    expect(
      canStallRecover({ recoveryInFlight: false, stall: 5 }, false, false, "content"),
    ).toEqual({ allowed: false, reason: "max_stalls_reached" });
  });
});

describe("chooseStallAction", () => {
  it("returns hls_reload on first stall when HLS is present", () => {
    expect(chooseStallAction(1, true, false, false, true)).toBe("hls_reload");
  });

  it("returns mpegts_reload on first stall when MPEG-TS is present", () => {
    expect(chooseStallAction(1, false, true, false, true)).toBe("mpegts_reload");
  });

  it("prefers hls over mpegts on first stall", () => {
    expect(chooseStallAction(1, true, true, false, true)).toBe("hls_reload");
  });

  it("returns stalker_refresh on second stall for direct channels", () => {
    expect(chooseStallAction(2, false, false, true, true)).toBe("stalker_refresh");
  });

  it("returns hls_reload on second stall when HLS is still present", () => {
    expect(chooseStallAction(2, true, false, false, true)).toBe("hls_reload");
  });

  it("returns mpegts_reload on second stall when MPEG-TS is still present", () => {
    expect(chooseStallAction(2, false, true, false, true)).toBe("mpegts_reload");
  });

  it("returns native_rebuild when no engine is available on any stall", () => {
    expect(chooseStallAction(1, false, false, false, true)).toBe("native_rebuild");
    expect(chooseStallAction(2, false, false, false, true)).toBe("native_rebuild");
    expect(chooseStallAction(3, false, false, false, true)).toBe("native_rebuild");
  });
});

describe("classifyRecoveryPath", () => {
  it("returns refresh_url on first stall with terminal HTTP error", () => {
    const result = classifyRecoveryPath(true, 0);
    expect(result).toEqual({ terminal: false, action: "refresh_url" });
  });

  it("returns show_terminal_error on second attempt with terminal HTTP error", () => {
    const result = classifyRecoveryPath(true, 2);
    expect(result).toEqual({ terminal: true, action: "show_terminal_error" });
  });

  it("returns non-terminal when no HTTP error", () => {
    const result = classifyRecoveryPath(false, 1);
    expect(result).toEqual({ terminal: false });
  });
});
