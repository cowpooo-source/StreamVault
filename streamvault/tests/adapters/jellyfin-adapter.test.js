import { describe, it, expect, beforeEach, vi } from "vitest";
import { JellyfinAdapter } from "../../src/adapters/jellyfin-adapter.js";

describe("JellyfinAdapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("authenticate", () => {
    it("should return accessToken and userId on success", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ AccessToken: "test-token-abc", UserId: "user-123" }),
        })
      );

      const result = await JellyfinAdapter.authenticate(
        "https://jellyfin.example.com",
        "testuser",
        "testpass"
      );

      expect(result).toEqual({ accessToken: "test-token-abc", userId: "user-123" });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://jellyfin.example.com/Users/AuthenticateByName",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ Username: "testuser", Pw: "testpass" }),
        })
      );
    });

    it("should throw Error('Auth failed') when response is not ok", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        })
      );

      await expect(
        JellyfinAdapter.authenticate("https://jellyfin.example.com", "baduser", "badpass")
      ).rejects.toThrow("Auth failed");
    });
  });

  describe("getLibrary", () => {
    it("should return items array from API response", async () => {
      const mockItems = [
        { Id: "item-1", Name: "Movie 1", Type: "Movie" },
        { Id: "item-2", Name: "Series 1", Type: "Series" },
      ];
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: mockItems, TotalRecordCount: 2 }),
        })
      );

      const result = await JellyfinAdapter.getLibrary(
        "https://jellyfin.example.com",
        "test-token",
        "user-123",
        { type: "Movie,Series", startIndex: 0, limit: 50 }
      );

      expect(result).toEqual({ items: mockItems, total: 2 });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://jellyfin.example.com/Items?IncludeItemTypes=Movie,Series&startIndex=0&limit=50&fields=PrimaryImageAspectRatio,MediaSources",
        expect.objectContaining({
          method: "GET",
          headers: {
            "X-Emby-Authorization": 'MediaBrowser UserId="user-123",Token="test-token"',
          },
        })
      );
    });

    it("should use default options when not provided", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: [], TotalRecordCount: 0 }),
        })
      );

      await JellyfinAdapter.getLibrary("https://jellyfin.example.com", "test-token", "user-123");

      expect(global.fetch).toHaveBeenCalledWith(
        "https://jellyfin.example.com/Items?IncludeItemTypes=Movie,Series&startIndex=0&limit=50&fields=PrimaryImageAspectRatio,MediaSources",
        expect.any(Object)
      );
    });
  });

  describe("getStreamUrl", () => {
    it("should return URL containing .m3u8", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          url: "https://jellyfin.example.com/stream/main.m3u8?token=abc123",
        })
      );

      const result = await JellyfinAdapter.getStreamUrl(
        "https://jellyfin.example.com",
        "test-token",
        "user-123",
        "item-123"
      );

      expect(result.url).toContain(".m3u8");
      expect(global.fetch).toHaveBeenCalledWith(
        "https://jellyfin.example.com/Videos/item-123/main.m3u8",
        expect.objectContaining({
          method: "GET",
          headers: {
            "X-Emby-Authorization": 'MediaBrowser UserId="user-123",Token="test-token"',
          },
        })
      );
    });
  });

  describe("getLiveTVChannels", () => {
    it("should return channels with ids", async () => {
      const mockChannels = [
        { Id: "ch-1", Name: "Channel 1", CallSign: "CH1" },
        { Id: "ch-2", Name: "Channel 2", CallSign: "CH2" },
      ];
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: mockChannels }),
        })
      );

      const result = await JellyfinAdapter.getLiveTVChannels(
        "https://jellyfin.example.com",
        "test-token",
        "user-123"
      );

      expect(result.channels).toEqual(mockChannels);
      expect(result.channels[0]).toHaveProperty("Id", "ch-1");
      expect(global.fetch).toHaveBeenCalledWith(
        "https://jellyfin.example.com/LiveTv/Channels",
        expect.objectContaining({
          method: "GET",
          headers: {
            "X-Emby-Authorization": 'MediaBrowser UserId="user-123",Token="test-token"',
          },
        })
      );
    });
  });

  describe("getLiveTVPrograms", () => {
    it("should return programs array", async () => {
      const mockPrograms = [
        { Id: "prog-1", Name: "Program 1", ChannelId: "ch-1" },
        { Id: "prog-2", Name: "Program 2", ChannelId: "ch-1" },
      ];
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ Items: mockPrograms }),
        })
      );

      const result = await JellyfinAdapter.getLiveTVPrograms(
        "https://jellyfin.example.com",
        "test-token",
        "user-123",
        "ch-1",
        "2026-05-29T00:00:00Z",
        "2026-05-29T12:00:00Z"
      );

      expect(result.programs).toEqual(mockPrograms);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://jellyfin.example.com/LiveTv/Programs?ChannelIds=ch-1&StartTime=2026-05-29T00:00:00Z&EndTime=2026-05-29T12:00:00Z&fields=MediaSources",
        expect.objectContaining({
          method: "GET",
          headers: {
            "X-Emby-Authorization": 'MediaBrowser UserId="user-123",Token="test-token"',
          },
        })
      );
    });
  });
});
