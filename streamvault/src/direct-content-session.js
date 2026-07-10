function currentLocation(locationObject = typeof window !== "undefined" ? window.location : { pathname: "", search: "" }) {
  return {
    pathname: locationObject?.pathname || "",
    search: locationObject?.search || "",
  };
}

function trimTrailingSlash(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function normalizeBaseUrl(baseUrl, fallback) {
  try {
    return new URL(String(baseUrl || fallback)).origin;
  } catch {
    return fallback;
  }
}

const DEFAULT_APP_BASE_URL = "https://media.portalheaven.stream";
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
  } catch {}
}

function safeSessionStorageRemove(key) {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(key);
    }
  } catch {}
}

export function isDirectContentConnection(connection) {
  return connection?.type === "xtream" || connection?.type === "m3u";
}

export function contentSessionPayload(connection) {
  const config = connection?.config || {};
  const safeConfig = {};
  for (const key of ["type", "server", "user", "pass", "url"]) {
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
  return `${normalizeBaseUrl(options.baseUrl, DEFAULT_APP_BASE_URL)}/`;
}

export function navigateToAppHome(options = {}) {
  const url = getAppHomeUrl(options);

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

  const res = await fetch(`/api/content-session/validate?token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    let message = "Content session expired or invalid";
    let code = "invalid";
    if (res.status === 401 || res.status === 403) code = "unauthorized";
    else if (res.status === 429) code = "rate_limited";
    else if (res.status >= 500) code = "server_error";
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
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
    } catch {}
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
