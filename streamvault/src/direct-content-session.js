const DIRECT_CONNECTION_TYPES = new Set(["xtream", "m3u"]);
const CONTENT_SESSION_ROUTE = "/api/content-session";
const CONTENT_SESSION_VALIDATE_ROUTE = "/api/content-session/validate";

function pickDefinedFields(source, keys) {
  const target = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) target[key] = source[key];
  }
  return target;
}

export function isDirectContentConnection(connection) {
  return !!connection && DIRECT_CONNECTION_TYPES.has(connection.type);
}

export function buildSafeContentSessionPayload(connection, item = {}) {
  return {
    connection: pickDefinedFields(connection, ["id", "type", "label", "server", "user", "url", "name"]),
    item: pickDefinedFields(item, ["id", "name", "url", "type", "logo", "group", "streamId", "channelId", "seriesId", "season", "episode"]),
  };
}

export function detectContentMode(locationLike = globalThis.location) {
  const pathname = locationLike?.pathname || "";
  if (pathname !== "/content" && pathname !== "/content/") {
    return { isContentMode: false, token: null };
  }

  const searchParams = new URLSearchParams(locationLike?.search || "");
  return {
    isContentMode: true,
    token: searchParams.get("token"),
  };
}

export async function validateContentSessionToken(token, fetchImpl = globalThis.fetch) {
  if (!token) return false;

  const response = await fetchImpl(`${CONTENT_SESSION_VALIDATE_ROUTE}?token=${encodeURIComponent(token)}`);
  return !!response?.ok;
}

export async function openDirectContentSession(connection, item, options = {}) {
  if (!isDirectContentConnection(connection)) {
    return { opened: false, contentUrl: null };
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  const navigate = options.navigate || ((url) => {
    if (typeof globalThis.location?.assign === "function") {
      globalThis.location.assign(url);
    } else {
      globalThis.location.href = url;
    }
  });

  const response = await fetchImpl(CONTENT_SESSION_ROUTE, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSafeContentSessionPayload(connection, item)),
  });

  if (!response?.ok) {
    return { opened: false, contentUrl: null };
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!data?.contentUrl) {
    return { opened: false, contentUrl: null };
  }

  navigate(data.contentUrl);
  return { opened: true, contentUrl: data.contentUrl };
}

export async function maybeOpenDirectContentSession(connection, item, options = {}) {
  const mode = options.contentMode ? { isContentMode: true, token: options.token ?? null } : detectContentMode(options.location);
  if (mode.isContentMode || !isDirectContentConnection(connection)) {
    return false;
  }

  const result = await openDirectContentSession(connection, item, options);
  return result.opened;
}

export function shouldUseTokenPlayerForItem(connection, item, locationLike = globalThis.location) {
  const { isContentMode } = detectContentMode(locationLike);
  return isContentMode && isDirectContentConnection(connection) && !!item;
}
