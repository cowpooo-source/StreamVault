/**
 * App-level connection session and lifecycle orchestration hooks.
 *
 * Extracted from App.jsx so the pure logic can be tested without
 * mounting the full 3500-line component.
 */

import {
  clearContentSessionToken,
  contentSessionToken,
  navigateToAppHome,
  persistContentSessionToken,
  validateContentSession,
} from "./direct-content-session.js";

/**
 * Hydrate a content session token into a normalized connection object.
 *
 * Used in App.jsx's main content-session useEffect.
 *
 * On success returns the normalized connection.
 * On auth failure (401/403) redirects to /app?reason=auth and returns null.
 * Other failures return null with an error message.
 *
 * @param {object} opts
 * @param {AbortSignal} opts.signal cancellation signal from the caller's cleanup
 * @param {string} opts.defaultColor fallback color for the hydrated connection
 * @returns {Promise<{ connection?: object, error?: string }>}
 */
export async function hydrateContentSession({ signal, defaultColor = "#4a90d9" } = {}) {
  const token = contentSessionToken();
  if (!token) {
    clearContentSessionToken();
    navigateToAppHome({ location: window.location, reason: "auth" });
    return { error: "session_auth_failure" };
  }

  persistContentSessionToken(token);
  if (window.location.search) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  let session;
  try {
    session = await validateContentSession(token);
  } catch (e) {
    const code = e?.code || e?.status;
    if (code === "unauthorized" || code === "invalid" || code === 401 || code === 403) {
      clearContentSessionToken();
      navigateToAppHome({ location: window.location, reason: "auth" });
      return { error: "session_auth_failure" };
    }
    return { error: e?.message || "Content session expired or invalid" };
  }

  if (signal?.aborted) return { error: "cancelled" };

  const sessionConnection = session?.connection;
  if (!sessionConnection?.id) {
    return { error: "Missing content session connection" };
  }

  const normalizedConnection = {
    ...sessionConnection,
    id: sessionConnection.id,
    type: sessionConnection.type || sessionConnection.config?.type || "xtream",
    label: sessionConnection.label || sessionConnection.config?.label || sessionConnection.id,
    color: sessionConnection.color || defaultColor,
    config: sessionConnection.config || sessionConnection,
  };

  return { connection: normalizedConnection, adEligible: session?.adEligible === true };
}

/**
 * Clean up the content session and navigate back to the secure app home.
 */
export function disconnectContentSession() {
  clearContentSessionToken();
  navigateToAppHome({ location: window.location });
}

/**
 * Determine whether the user should be sent to connection selection
 * or redirected to /app for content-session users.
 *
 * Returns "show_manager" or "navigate_home".
 */
export function decideLeaveContentForConnection(httpContentMode) {
  if (!httpContentMode) return "show_manager";
  return "navigate_home"; // caller shows confirm, clears token, navigates
}

/**
 * Disconnect a regular (non-content-session) connection.
 * Returns the reset state object.
 */
export function resetRegularConnectionState(dbSet) {
  if (dbSet) dbSet("sv-activeConn", null);
  return {
    conn: null,
    channels: [],
    vod: [],
    series: [],
    stalkerVodCats: [],
    stalkerSeriesCats: [],
    section: "live",
    playing: null,
    cat: "All",
    activeConnId: null,
  };
}

/**
 * Return the active connection object from either an ephemeral
 * content-session connection or the persistent connections list.
 */
export function resolveActiveConnection(ephemeralConnection, connections, activeConnId) {
  if (ephemeralConnection) return ephemeralConnection;
  return connections.find(c => c.id === activeConnId) || null;
}

/**
 * Check whether the current user is allowed on the page.
 * Guests and authenticated users both get access; users without
 * a connection should not see content.
 */
export function isNavigationAllowed(authUser, isGuest, hasConnection) {
  return (authUser || isGuest) && hasConnection;
}
