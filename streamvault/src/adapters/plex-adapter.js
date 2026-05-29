/**
 * Plex API Adapter for browser-side calls
 * Implements Plex PIN-based OAuth flow for authentication
 */

const PLEX_AUTH_URL = 'https://clients.plex.tv/api/v2/pins';

export const PlexAdapter = {
  async createPin(clientId = crypto.randomUUID()) {
    const response = await fetch(PLEX_AUTH_URL, {
      method: "POST",
      headers: {
        "X-Plex-Client-Identifier": clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "standard" }),
    });

    if (!response.ok) {
      throw new Error("Failed to create PIN");
    }

    const data = await response.json();
    return { pinId: data.id.toString(), code: data.code };
  },

  async pollPin(pinId) {
    const response = await fetch(`${PLEX_AUTH_URL}/${pinId}`, {
      method: "GET",
      headers: {
        "X-Plex-Client-Identifier": crypto.randomUUID(),
      },
    });

    if (!response.ok) {
      throw new Error("Failed to poll PIN");
    }

    const data = await response.json();
    return { authToken: data.authToken || null, expiresAt: data.expiresAt };
  },

  async getResources(authToken) {
    const response = await fetch("https://plex.tv/api/v2/resources", {
      method: "GET",
      headers: {
        "X-Plex-Token": authToken,
      },
    });

    if (!response.ok) {
      throw new Error("Failed to get resources");
    }

    const data = await response.json();
    const resources = data.MediaContainer?.Resource || [];

    return {
      servers: resources.map((r) => ({
        name: r.name,
        product: r.product,
        connections: (r.connections || []).map((c) => ({
          protocol: c.protocol,
          address: c.address,
          local: c.local,
          reachable: c.reachable,
        })),
      })),
    };
  },

  async getLibrary(baseUrl, token, { type = "movie" } = {}) {
    const sectionsResponse = await fetch(`${baseUrl}/library/sections`, {
      method: "GET",
      headers: {
        "X-Plex-Token": token,
      },
    });

    if (!sectionsResponse.ok) {
      throw new Error("Failed to get library sections");
    }

    const sectionsData = await sectionsResponse.json();
    const sections = sectionsData.MediaContainer?.Directory || [];

    const section = sections.find((s) => s.type === type);

    if (!section) {
      return { items: [] };
    }

    const libraryResponse = await fetch(`${baseUrl}/library/sections/${section.key}/all`, {
      method: "GET",
      headers: {
        "X-Plex-Token": token,
      },
    });

    if (!libraryResponse.ok) {
      throw new Error("Failed to get library items");
    }

    const libraryData = await libraryResponse.json();
    return { items: libraryData.MediaContainer?.Video || [] };
  },

  getStreamUrl(baseUrl, itemId, token) {
    return (
      baseUrl +
      "/video/:/transcode/universal/start.m3u8?path=/library/metadata/" +
      itemId +
      "&X-Plex-Token=" +
      token
    );
  },
};