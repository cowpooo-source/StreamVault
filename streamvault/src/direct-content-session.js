function currentLocation(locationObject = typeof window !== "undefined" ? window.location : { pathname: "", search: "" }) {
  return {
    pathname: locationObject?.pathname || "",
    search: locationObject?.search || "",
  };
}

function trimTrailingSlash(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
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
  return isHttpContentMode(locationObject) ? new URLSearchParams(search).get("token") : null;
}

export async function validateContentSession(token) {
  if (!token) throw new Error("Missing content session token");

  const res = await fetch(`/api/content-session/validate?token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    let message = "Content session expired or invalid";
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
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
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
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


