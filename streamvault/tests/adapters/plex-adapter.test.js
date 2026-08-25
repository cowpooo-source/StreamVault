import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlexAdapter } from "../../src/adapters/plex-adapter.js";

describe("PlexAdapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("createPin", () => {
    it("creates PIN and returns pinId and code", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 12345, code: "ABC123" }),
        })
      );

      const result = await PlexAdapter.createPin("test-client-id");

      expect(result).toEqual({ pinId: "12345", code: "ABC123" });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://clients.plex.tv/api/v2/pins",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "X-Plex-Client-Identifier": "test-client-id",
            "Content-Type": "application/json",
            "X-Plex-Product": "StreamVault",
          }),
          body: JSON.stringify({ type: "standard" }),
        })
      );
    });

    it("uses random UUID as default clientId", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 99999, code: "XYZ789" }),
        })
      );

      await PlexAdapter.createPin();

      const call = global.fetch.mock.calls[0];
      const clientId = call[1].headers["X-Plex-Client-Identifier"];
      // UUID format check - should be non-empty and reasonable length
      expect(typeof clientId).toBe("string");
      expect(clientId.length).toBeGreaterThan(10);
    });

    it("throws error when response is not ok", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        })
      );

      await expect(PlexAdapter.createPin()).rejects.toThrow("Failed to Plex PIN create");
    });
  });

  describe("pollPin", () => {
    it("returns authToken when approved", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              authToken: "plex-auth-token-abc",
              expiresAt: "2026-05-29T12:00:00Z",
            }),
        })
      );

      const result = await PlexAdapter.pollPin("12345");

      expect(result).toEqual({
        authToken: "plex-auth-token-abc",
        expiresAt: "2026-05-29T12:00:00Z",
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://clients.plex.tv/api/v2/pins/12345",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "X-Plex-Client-Identifier": expect.any(String),
          }),
        })
      );
    });

    it("returns null authToken when still pending", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              authToken: null,
              expiresAt: "2026-05-29T12:00:00Z",
            }),
        })
      );

      const result = await PlexAdapter.pollPin("12345");

      expect(result).toEqual({
        authToken: null,
        expiresAt: "2026-05-29T12:00:00Z",
      });
    });

    it("throws error when response is not ok", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        })
      );

      await expect(PlexAdapter.pollPin("12345")).rejects.toThrow("Failed to poll PIN");
    });
  });

  describe("getResources", () => {
    it("returns servers with connections shape", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              MediaContainer: {
                Resource: [
                  {
                    name: "My Plex Server",
                    product: "plex",
                    connections: [
                      {
                        protocol: "http",
                        address: "192.168.1.100:32400",
                        local: true,
                        reachable: false,
                      },
                      {
                        protocol: "https",
                        address: "my-plex-server.plex.direct:32400",
                        local: false,
                        reachable: true,
                      },
                    ],
                  },
                ],
              },
            }),
        })
      );

      const result = await PlexAdapter.getResources("test-auth-token");

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]).toEqual({
        name: "My Plex Server",
        product: "plex",
        connections: [
          {
            protocol: "https",
            address: "my-plex-server.plex.direct:32400",
            port: 32400,
            local: 0,
            reachable: true,
            relay: undefined,
            uri: "https://my-plex-server.plex.direct:32400",
          },
          {
            protocol: "http",
            address: "192.168.1.100:32400",
            port: 32400,
            local: 1,
            reachable: false,
            relay: undefined,
            uri: "http://192.168.1.100:32400",
          },
        ],
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://plex.tv/api/v2/resources",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Plex-Token": "test-auth-token",
            "X-Plex-Product": "StreamVault",
          }),
        })
      );
    });

    it("returns empty servers array when no resources", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ MediaContainer: {} }),
        })
      );

      const result = await PlexAdapter.getResources("test-auth-token");

      expect(result.servers).toEqual([]);
    });

    it("throws error when response is not ok", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({}),
        })
      );

      await expect(PlexAdapter.getResources("test-auth-token")).rejects.toThrow(
        "Failed to Plex resources"
      );
    });
  });

  describe("getLibrary", () => {
    it("returns items from matching section type", async () => {
      global.fetch = vi.fn();
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              MediaContainer: {
                Directory: [{ key: "1", type: "movie" }, { key: "2", type: "show" }],
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              MediaContainer: {
                Video: [{ ratingKey: "item-1", title: "Movie 1" }, { ratingKey: "item-2", title: "Movie 2" }],
              },
            }),
        });

      const result = await PlexAdapter.getLibrary(
        "https://plex.example.com:32400",
        "test-token",
        { type: "movie" }
      );

      expect(result.items).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://plex.example.com:32400/library/sections?X-Plex-Token=test-token",
        expect.objectContaining({ headers: expect.objectContaining({ "X-Plex-Token": "test-token" }) })
      );
      expect(global.fetch).toHaveBeenCalledWith(
        "https://plex.example.com:32400/library/sections/1/all?X-Plex-Token=test-token",
        expect.objectContaining({ headers: expect.objectContaining({ "X-Plex-Token": "test-token" }) })
      );
    });

    it("returns empty items when no matching section", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              MediaContainer: {
                Directory: [{ key: "1", type: "show" }],
              },
            }),
        })
      );

      const result = await PlexAdapter.getLibrary(
        "https://plex.example.com:32400",
        "test-token",
        { type: "movie" }
      );

      expect(result.items).toEqual([]);
    });
  });

  describe("getStreamUrl", () => {
    it("returns transcode URL with token", () => {
      const result = PlexAdapter.getStreamUrl(
        "https://plex.example.com:32400",
        "item-123",
        "my-token"
      );

      expect(result).toBe(
        "https://plex.example.com:32400/video/:/transcode/universal/start.m3u8?path=/library/metadata/item-123&mediaIndex=0&partIndex=0&protocol=hls&X-Plex-Token=my-token&X-Plex-Client-Identifier=test-uuid-1234&X-Plex-Product=StreamVault&X-Plex-Version=0.1.0&X-Plex-Platform=Web&X-Plex-Device=StreamVault"
      );
    });
  });
});