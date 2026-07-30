import { describe, expect, it } from "vitest";
import { pickAndValidateStalkerParams } from "../src/services/stalkerRequestParams.js";

describe("pickAndValidateStalkerParams", () => {
  it("accepts dedicated playback fields without forwarding credentials", () => {
    const { params } = pickAndValidateStalkerParams({
      portal: "http://portal.test/c/",
      mac: "00:11:22:33:44:55",
      cmd: "ffmpeg http://localhost/ch/123",
      content_type: "live",
      channel_id: "123",
      resolve: "1",
    }, "play");

    expect(params).toEqual({
      cmd: "ffmpeg http://localhost/ch/123",
      content_type: "live",
      channel_id: "123",
    });
  });

  it("rejects unknown fields on dedicated routes", () => {
    expect(() => pickAndValidateStalkerParams({ cat: "1", injected: "yes" }, "vod"))
      .toThrow(/Unknown Stalker parameter/);
  });

  it("rejects arrays and invalid numeric values", () => {
    expect(() => pickAndValidateStalkerParams({ period: ["1", "2"] }, "epg"))
      .toThrow(/single value/);
    expect(() => pickAndValidateStalkerParams({ period: "1.5" }, "epg"))
      .toThrow(/non-negative integer/);
  });

  it("allows long opaque playback commands but enforces their bound", () => {
    expect(() => pickAndValidateStalkerParams({ cmd: `svopaque:${"a".repeat(3000)}` }, "play"))
      .not.toThrow();
    expect(() => pickAndValidateStalkerParams({ cmd: "a".repeat(4097) }, "play"))
      .toThrow(/maximum length/);
  });
});
