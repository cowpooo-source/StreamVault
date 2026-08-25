import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { mapJellyfinChannel, mapJellyfinProgram, mergeJellyfinEPG } from "../../../src/epg.js";
import JellyfinEPGAdapter from "../../../src/components/epg/JellyfinEPGAdapter.jsx";

describe("mapJellyfinChannel", () => {
  it("maps Jellyfin channel to EPG channel shape with id, name, number, logo", () => {
    const jellyfinChannel = {
      Id: "ch-uuid-123",
      Name: "BBC One",
      Number: "1",
      ChannelNumber: 1,
      ImageUrl: "https://example.com/bbc.png"
    };

    const result = mapJellyfinChannel(jellyfinChannel);

    expect(result).toEqual({
      id: "ch-uuid-123",
      name: "BBC One",
      number: "1",
      logo: "https://example.com/bbc.png"
    });
  });

  it("uses ChannelNumber when Number is not available", () => {
    const jellyfinChannel = {
      Id: "ch-uuid-456",
      Name: "BBC Two",
      ChannelNumber: 2
    };

    const result = mapJellyfinChannel(jellyfinChannel);

    expect(result.number).toBe(2);
  });

  it("sets logo to null when ImageUrl is not available", () => {
    const jellyfinChannel = {
      Id: "ch-uuid-789",
      Name: "Channel Without Logo"
    };

    const result = mapJellyfinChannel(jellyfinChannel);

    expect(result.logo).toBeNull();
  });
});

describe("mapJellyfinProgram", () => {
  it("maps Jellyfin program to EPG program shape with id, channel, title, startMs, endMs", () => {
    const jellyfinProgram = {
      Id: "prog-uuid-001",
      ChannelId: "ch-uuid-123",
      Name: "The News at Six",
      Title: "The News at Six",
      Overview: "Daily news bulletin.",
      StartTime: "2026-05-29T18:00:00Z",
      EndTime: "2026-05-29T18:30:00Z",
      ImageUrl: "https://example.com/news.jpg"
    };

    const result = mapJellyfinProgram(jellyfinProgram);

    expect(result.id).toBe("prog-uuid-001");
    expect(result.channel).toBe("ch-uuid-123");
    expect(result.title).toBe("The News at Six");
    expect(result.description).toBe("Daily news bulletin.");
    expect(result.startMs).toBe(new Date("2026-05-29T18:00:00Z").getTime());
    expect(result.endMs).toBe(new Date("2026-05-29T18:30:00Z").getTime());
    expect(result.image).toBe("https://example.com/news.jpg");
  });

  it("uses Name when Title is not available", () => {
    const jellyfinProgram = {
      Id: "prog-uuid-002",
      ChannelId: "ch-uuid-123",
      Name: "Movie Title Here",
      StartTime: "2026-05-29T20:00:00Z",
      EndTime: "2026-05-29T22:00:00Z"
    };

    const result = mapJellyfinProgram(jellyfinProgram);

    expect(result.title).toBe("Movie Title Here");
  });

  it("handles missing description gracefully", () => {
    const jellyfinProgram = {
      Id: "prog-uuid-003",
      ChannelId: "ch-uuid-123",
      Name: "Short Program",
      StartTime: "2026-05-29T14:00:00Z",
      EndTime: "2026-05-29T14:15:00Z"
    };

    const result = mapJellyfinProgram(jellyfinProgram);

    expect(result.description).toBe("");
  });
});

describe("mergeJellyfinEPG", () => {
  it("groups programs under their channels", () => {
    const channels = [
      { Id: "ch-1", Name: "Channel 1", Number: "1" },
      { Id: "ch-2", Name: "Channel 2", Number: "2" }
    ];
    const programs = [
      { Id: "p1", ChannelId: "ch-1", Name: "Program 1 on Ch1", StartTime: "2026-05-29T10:00:00Z", EndTime: "2026-05-29T11:00:00Z" },
      { Id: "p2", ChannelId: "ch-1", Name: "Program 2 on Ch1", StartTime: "2026-05-29T11:00:00Z", EndTime: "2026-05-29T12:00:00Z" },
      { Id: "p3", ChannelId: "ch-2", Name: "Program 1 on Ch2", StartTime: "2026-05-29T10:30:00Z", EndTime: "2026-05-29T11:30:00Z" }
    ];

    const result = mergeJellyfinEPG(channels, programs);

    expect(result).toHaveLength(2);

    const ch1 = result.find(c => c.id === "ch-1");
    expect(ch1).toBeDefined();
    expect(ch1.programs).toHaveLength(2);
    expect(ch1.programs[0].title).toBe("Program 1 on Ch1");
    expect(ch1.programs[1].title).toBe("Program 2 on Ch1");

    const ch2 = result.find(c => c.id === "ch-2");
    expect(ch2).toBeDefined();
    expect(ch2.programs).toHaveLength(1);
    expect(ch2.programs[0].title).toBe("Program 1 on Ch2");
  });

  it("ignores programs for channels not in the channels list", () => {
    const channels = [
      { Id: "ch-1", Name: "Channel 1", Number: "1" }
    ];
    const programs = [
      { Id: "p1", ChannelId: "ch-1", Name: "Valid Program", StartTime: "2026-05-29T10:00:00Z", EndTime: "2026-05-29T11:00:00Z" },
      { Id: "p2", ChannelId: "ch-unknown", Name: "Orphan Program", StartTime: "2026-05-29T10:00:00Z", EndTime: "2026-05-29T11:00:00Z" }
    ];

    const result = mergeJellyfinEPG(channels, programs);

    expect(result).toHaveLength(1);
    expect(result[0].programs).toHaveLength(1);
    expect(result[0].programs[0].title).toBe("Valid Program");
  });

  it("returns empty array when no channels provided", () => {
    const result = mergeJellyfinEPG([], [{ Id: "p1", ChannelId: "ch-1", Name: "Orphan", StartTime: "2026-05-29T10:00:00Z", EndTime: "2026-05-29T11:00:00Z" }]);
    expect(result).toHaveLength(0);
  });
});

describe("JellyfinEPGAdapter component", () => {
  it("is a thin wrapper that returns mergeJellyfinEPG result", () => {
    const channels = [
      { Id: "ch-1", Name: "BBC One", Number: "1" }
    ];
    const programs = [
      { Id: "p1", ChannelId: "ch-1", Name: "News", StartTime: "2026-05-29T18:00:00Z", EndTime: "2026-05-29T18:30:00Z" }
    ];

    // JellyfinEPGAdapter is a thin wrapper that returns data from mergeJellyfinEPG
    const result = JellyfinEPGAdapter({ channels, programs });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ch-1");
    expect(result[0].name).toBe("BBC One");
    expect(result[0].programs).toHaveLength(1);
    expect(result[0].programs[0].title).toBe("News");
  });
});
