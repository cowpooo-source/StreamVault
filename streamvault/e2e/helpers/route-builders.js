/**
 * Route pattern builders for provider API mocking.
 *
 * These produce glob patterns compatible with page.route() and
 * page.waitForRequest() without hitting real providers.
 */

/**
 * Build a proxy route pattern that matches requests for a given Xtream action.
 */
export function xtreamProxyRoute(server = "http://provider.test") {
  return `**/proxy?url=${encodeURIComponent(server)}**`;
}

/**
 * Build a proxy route pattern for an M3U playlist URL.
 */
export function m3uProxyRoute(playlistUrl = "http://provider.test/playlist.m3u") {
  return `**/proxy?url=${encodeURIComponent(playlistUrl)}**`;
}

/**
 * Build a Stalker portal route pattern.
 */
export function stalkerPortalRoute() {
  return `**/stalker**`;
}

/**
 * Content-session API route patterns.
 */
export const CONTENT_SESSION_ROUTES = {
  create: "**/api/content-session",
  validate: "**/api/content-session/validate**",
  refresh: "**/api/content-session/refresh**",
  delete: "**/api/content-session",
};
