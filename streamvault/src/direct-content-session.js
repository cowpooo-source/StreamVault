function currentLocation(locationObject = typeof window !== "undefined" ? window.location : { pathname: "", search: "" }) {
  return {
    pathname: locationObject?.pathname || "",
    search: locationObject?.search || "",
  };
}

function trimTrailingSlash(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function normalizeSecureAppUrl(baseUrl, fallback) {
  try {
    const url = new URL(String(baseUrl || fallback));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    const pathname = trimTrailingSlash(url.pathname);
    const appPath = pathname === "/app" || pathname.startsWith("/app/") ? pathname : "/app";
    return `${url.origin}${appPath}`;
  } catch {
    throw new Error("Secure app URL must be configured with an HTTP or HTTPS URL");
  }
}

// Secure (HTTPS) app URL. Configured at build time via VITE_SECURE_APP_BASE_URL.
// Falls back to the current origin in development so tests and local builds work.
function secureAppBaseUrl() {
  const fromEnv = import.meta.env?.VITE_SECURE_APP_BASE_URL;
  if (fromEnv) return fromEnv;
  if (import.meta.env?.DEV && typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "";
}
const CONTENT_SESSION_STORAGE_KEY = "sv-content-session-token";

function safeSessionStorageRead(key) {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSessionStorageWrite(key, value) {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(key, value);
    }
  } catch { /* session storage may be unavailable */ }
}

function safeSessionStorageRemove(key) {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(key);
    }
  } catch { /* session storage may be unavailable */ }
}

export function isDirectContentConnection(connection) {
  return connection?.type === "xtream" || connection?.type === "m3u" || connection?.type === "stalker";
}

export function contentSessionPayload(connection) {
  const config = connection?.config || {};
  const safeConfig = {};
  for (const key of ["type", "server", "user", "pass", "url", "mac", "serial", "deviceId", "deviceId2"]) {
    if (config[key] !== undefined) safeConfig[key] = config[key];
  }

  return {
    connection: {
      id: connection?.id,
      type: connection?.type,
      label: connection?.label,
      config: safeConfig,
    },
  };
}

export function isHttpContentMode(locationObject = typeof window !== "undefined" ? window.location : { pathname: "", search: "" }) {
  return trimTrailingSlash(currentLocation(locationObject).pathname) === "/content";
}

export function contentSessionToken(locationObject = typeof window !== "undefined" ? window.location : { pathname: "", search: "" }) {
  const { search } = currentLocation(locationObject);
  if (!isHttpContentMode(locationObject)) return null;
  const fromUrl = new URLSearchParams(search).get("token");
  return fromUrl || safeSessionStorageRead(CONTENT_SESSION_STORAGE_KEY);
}

export function persistContentSessionToken(token) {
  if (!token) return;
  safeSessionStorageWrite(CONTENT_SESSION_STORAGE_KEY, token);
}

export function clearContentSessionToken() {
  safeSessionStorageRemove(CONTENT_SESSION_STORAGE_KEY);
}

export function getAppHomeUrl(options = {}) {
  return normalizeSecureAppUrl(options.baseUrl, secureAppBaseUrl());
}

export function navigateToAppHome(options = {}) {
  const target = new URL(getAppHomeUrl(options));
  if (options.reason) target.searchParams.set("reason", options.reason);
  const url = target.toString();

  if (typeof options.navigate === "function") {
    options.navigate(url);
    return url;
  }

  const locationObject = options.location || (typeof window !== "undefined" ? window.location : null);
  if (locationObject && typeof locationObject.assign === "function") {
    locationObject.assign(url);
  } else if (typeof window !== "undefined" && window.location) {
    if (typeof window.location.assign === "function") {
      window.location.assign(url);
    } else {
      window.location.href = url;
    }
  }

  return url;
}

export async function validateContentSession(token) {
  if (!token) throw new Error("Missing content session token");

  const { authHeaders } = await import("./app-runtime.js");
  const res = await fetch(`/api/content-session/validate?token=${encodeURIComponent(token)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    let message = "Content session expired or invalid";
    let code = "invalid";
    if (res.status === 401 || res.status === 403) code = "unauthorized";
    else if (res.status === 429) code = "rate_limited";
    else if (res.status >= 500) code = "server_error";
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* response body is optional */ }
    const err = new Error(message);
    err.code = code;
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) return true;

  const text = await res.text();
  if (!text.trim()) return true;
  try {
    return JSON.parse(text);
  } catch {
    return true;
  }
}

export async function refreshContentSession(token) {
  if (!token) throw new Error("Missing content session token");
  const { authHeaders } = await import("./app-runtime.js");
  const res = await fetch("/api/content-session/refresh", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    let message = "Content session expired or invalid";
    let code = res.status === 410 ? "expired" : "invalid";
    if (res.status === 401 || res.status === 403) code = "unauthorized";
    else if (res.status === 429) code = "rate_limited";
    else if (res.status >= 500) code = "server_error";
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      if (body?.code) code = body.code;
    } catch { /* response body is optional */ }
    const error = new Error(message);
    error.code = code;
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export async function openDirectContentSession(connection, options = {}) {
  const { authHeaders } = await import("./app-runtime.js");
  const res = await fetch("/api/content-session", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(contentSessionPayload(connection)),
  });

  if (!res.ok) {
    let message = "Failed to open direct content session";
    let code = "server_error";
    if (res.status === 401 || res.status === 403) code = "unauthorized";
    else if (res.status === 429) code = "rate_limited";
    else if (res.status >= 400 && res.status < 500) code = "invalid";
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* response body is optional */ }
    const err = new Error(message);
    err.code = code;
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (!data?.contentUrl) throw new Error("Missing content URL");

  if (typeof options.navigate === "function") {
    options.navigate(data.contentUrl);
  } else if (typeof window !== "undefined" && window.location) {
    if (typeof window.location.assign === "function") {
      window.location.assign(data.contentUrl);
    } else {
      window.location.href = data.contentUrl;
    }
  }

  return data;
}

export async function maybeOpenDirectContentSession(connection, options = {}) {
  if (!isDirectContentConnection(connection) || isHttpContentMode(options.location)) return false;
  await openDirectContentSession(connection, options);
  return true;
}

export function shouldUseTokenPlayerForItem(connection, item, locationObject = typeof window !== "undefined" ? window.location : { pathname: "", search: "" }) {
  return isDirectContentConnection(connection) && !!item && !isHttpContentMode(locationObject);
}
