import { describe, expect, it } from "vitest";
import { toSeriesEpisodeDisplay } from "../src/series-episode-display.js";

describe("toSeriesEpisodeDisplay", () => {
  it("renders Stalker episode objects as primitive values", () => {
    const episodes = toSeriesEpisodeDisplay([{
      id: "ep-1",
      num: 1,
      title: "Pilot",
      cmd: "/media/pilot.mpg",
      episode_id: "ep-1",
      season_id: "season-1",
      series_number: 1,
      video_id: "video-1",
    }]);

    expect(episodes).toEqual([{ num: 1, label: "Pilot" }]);
    expect(typeof episodes[0].num).toBe("number");
    expect(typeof episodes[0].label).toBe("string");
  });

  it("supports primitive and Xtream episode records", () => {
    expect(toSeriesEpisodeDisplay([2, { id: "3", title: "Finale" }], true)).toEqual([
      { num: 2, label: "Episode 2" },
      { num: "3", label: "Finale" },
    ]);
  });
});
