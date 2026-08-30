import { describe, expect, it } from "vitest";
import { selectStalkerEpgChannels } from "../src/stalker-epg.js";

describe("selectStalkerEpgChannels", () => {
  it("returns unique provider channel ids within the EPG request budget", () => {
    const channels = [
      { id: "1", name: "One" },
      { id: "1", name: "Duplicate" },
      { id: "", name: "Missing id" },
      { id: "2", name: "Two" },
      { id: "3", name: "Three" },
    ];

    expect(selectStalkerEpgChannels(channels, 2)).toEqual([
      { id: "1", name: "One" },
      { id: "2", name: "Two" },
    ]);
  });
});
