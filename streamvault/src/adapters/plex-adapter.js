/**
 * Plex API Adapter for browser-side calls.
 * Plex returns several response shapes depending on endpoint and client.
 */

const PLEX_AUTH_URL = "https://clients.plex.tv/api/v2/pins";
const PLEX_RESOURCES_URL = "https://plex.tv/api/v2/resources";
const PLEX_HEADERS = {
  "X-Plex-Product": "StreamVault",
  "X-Plex-Version": "0.1.0",
  "X-Plex-Platform": "Web",
  "X-Plex-Device": "StreamVault",
  "X-Plex-Device-Name": "StreamVault",
};

function getClientId() {
  try {
    const key = "plex_client_id";
    let id = localStorage.getItem(key);
    if (!id) {
      id = globalThis.crypto?.randomUUID?.() || `streamvault-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return globalThis.crypto?.randomUUID?.() || `streamvault-${Date.now()}`;
  }
}

function parseXml(xml, label) {
  if (typeof DOMParser === "undefined") throw new Error(`${label}: XML response is not supported in this browser`);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`${label}: invalid XML response`);
  const container = doc.querySelector("MediaContainer");
  if (!container) throw new Error(`${label}: XML missing MediaContainer`);
  const attrs = (element) => Object.fromEntries(Array.from(element.attributes).map((a) => [a.name, a.value]));
  const resources = Array.from(container.children).filter((el) => el.tagName === "Resource").map((resource) => ({
    ...attrs(resource),
    Connection: Array.from(resource.children).filter((el) => el.tagName === "Connection").map((connection) => attrs(connection)),
  }));
  const directory = Array.from(container.children).filter((el) => el.tagName === "Directory").map(attrs);
  const metadata = Array.from(container.children).filter((el) => el.tagName === "Video" || el.tagName === "Directory").map(attrs);
  return { MediaContainer: { Resource: resources, Directory: directory, Metadata: metadata } };
}

async function readBody(response, label) {
  if (typeof response.text !== "function") return response.json();
  const text = await response.text();
  if (!text.trim()) throw new Error(`${label}: empty response (HTTP ${response.status})`);
  if (text.trimStart().startsWith("<")) return parseXml(text, label);
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label}: invalid JSON/XML response (${error.message})`); }
}

function normalizeConnection(connection = {}) {
  const protocol = connection.protocol === "https" ? "https" : "http";
  const local = connection.local === true || connection.local === 1 || connection.local === "1" ? 1 : 0;
  const port = Number(connection.port) || 32400;
  const address = connection.address || "";
  return {
    protocol,
    address,
    port,
    local,
    reachable: connection.reachable,
    relay: connection.relay,
    uri: connection.uri || `${protocol}://${address}:${port}`,
  };
}

function rankConnections(connections = []) {
  return [...connections].map(normalizeConnection).sort((a, b) => {
    const score = (c) => (c.protocol === "https" ? 4 : 0) + (c.local === 0 ? 2 : 0) + (c.reachable === true ? 1 : 0) + (c.relay ? -1 : 0);
    return score(b) - score(a);
  });
}

async function plexFetch(url, options = {}, label = "Plex request") {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) throw new Error(`Failed to ${label}: HTTP ${response.status}`);
  return response;
}

export const PlexAdapter = {
  async createPin(clientId = getClientId()) {
    const response = await plexFetch(PLEX_AUTH_URL, {
      method: "POST",
      headers: { ...PLEX_HEADERS, "X-Plex-Client-Identifier": clientId, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "standard" }),
    });
    const data = await readBody(response, "Plex PIN create");
    return { pinId: String(data.id), code: data.code };
  },

  async pollPin(pinId, clientId = getClientId()) {
    const response = await fetch(`${PLEX_AUTH_URL}/${encodeURIComponent(pinId)}`, {
      cache: "no-store",
      headers: { ...PLEX_HEADERS, "X-Plex-Client-Identifier": clientId, Accept: "application/json" },
    });
    // A consumed or expired PIN should not trap the setup screen in an error loop.
    if (response.status === 404) return { authToken: null, expired: true };
    if (!response.ok) throw new Error(`Failed to poll PIN: HTTP ${response.status}`);
    const data = await readBody(response, "Plex PIN poll");
    return { authToken: data.authToken || null, expiresAt: data.expiresAt };
  },

  async getResources(authToken, clientId = getClientId()) {
    const response = await plexFetch(PLEX_RESOURCES_URL, {
      headers: { ...PLEX_HEADERS, "X-Plex-Token": authToken, "X-Plex-Client-Identifier": clientId, Accept: "application/json" },
    });
    const data = await readBody(response, "Plex resources");
    const resources = Array.isArray(data) ? data : data.MediaContainer?.Resource || data.Resource || [];
    return {
      servers: resources
        .filter((resource) => resource && (resource.provides === "server" || /plex( media server)?/i.test(resource.product || "")))
        .map((resource) => ({
          name: resource.name,
          product: resource.product,
          connections: rankConnections(resource.connections || resource.Connection || []),
        })),
    };
  },

  async getLibrary(baseUrl, token, { type = "movie" } = {}, clientId = getClientId()) {
    const headers = { ...PLEX_HEADERS, "X-Plex-Token": token, "X-Plex-Client-Identifier": clientId, Accept: "application/json" };
    const sectionsResponse = await plexFetch(`${baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`, { headers });
    const sectionsData = await readBody(sectionsResponse, "Plex library sections");
    const sections = sectionsData.MediaContainer?.Directory || [];
    const section = sections.find((entry) => entry.type === type);
    if (!section) return { items: [] };
    const libraryResponse = await plexFetch(`${baseUrl}/library/sections/${encodeURIComponent(section.key)}/all?X-Plex-Token=${encodeURIComponent(token)}`, { headers });
    const libraryData = await readBody(libraryResponse, "Plex library items");
    return { items: libraryData.MediaContainer?.Video || libraryData.MediaContainer?.Metadata || [] };
  },

  getStreamUrl(baseUrl, itemId, token, clientId = getClientId()) {
    return `${baseUrl}/video/:/transcode/universal/start.m3u8?path=/library/metadata/${encodeURIComponent(itemId)}&mediaIndex=0&partIndex=0&protocol=hls&X-Plex-Token=${encodeURIComponent(token)}&X-Plex-Client-Identifier=${encodeURIComponent(clientId)}&X-Plex-Product=StreamVault&X-Plex-Version=0.1.0&X-Plex-Platform=Web&X-Plex-Device=StreamVault`;
  },

  getStreamHeaders(token, clientId = getClientId()) {
    return { ...PLEX_HEADERS, "X-Plex-Token": token, "X-Plex-Client-Identifier": clientId };
  },
};

export { getClientId, normalizeConnection, rankConnections };