// Stalker portal session management — ported from stalker-proxy/src/index.js
// Uses CF KV for path caching instead of in-memory Map

const API_PATHS = [
  "server/load.php",
  "portal.php",
  "stalker_portal/server/load.php",
];

function cacheKey(portal, mac) {
  return `path:${portal.replace(/\/+$/, "")}|${mac}`;
}

function stalkerHeaders(mac, token = "", portalUrl = "", opts = {}) {
  const referer = portalUrl
    ? portalUrl.replace(/\/+$/, "").replace(/\/c$/, "") + "/c/"
    : "http://localhost/";
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
    Accept: "*/*",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-User-Agent": "Model: MAG250; Link: WiFi",
    Authorization: token ? `Bearer ${token}` : "Bearer ",
    Cookie: `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe%2FParis`,
    Referer: referer,
  };
  if (opts.serial) headers["Cookie"] += `; sn=${opts.serial}`;
  return headers;
}

async function tryHandshake(base, apiPath, mac, portalUrl, opts = {}) {
  const qs = `type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;
  const url = `${base}${apiPath}?${qs}`;
  const headers = stalkerHeaders(mac, "", portalUrl, opts);

  try {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      throw Object.assign(new Error("rate limited"), { code: "RATE_LIMITED" });
    }
    if (res.status === 404) return null;
    if (res.ok) {
      const data = await res.json();
      const token = data?.js?.token;
      if (token) return { token, base, apiPath };
    }
  } catch (e) {
    if (e.code === "RATE_LIMITED") throw e;
  }
  return null;
}

export async function getSession(portal, mac, opts = {}, kvCache = null) {
  const key = cacheKey(portal, mac);

  // Check KV for cached path
  let cached = null;
  if (kvCache) {
    const raw = await kvCache.get(key, "json");
    if (raw) cached = raw;
  }

  // If path is known, do a single handshake on the known path
  if (cached) {
    const result = await tryHandshake(cached.base, cached.apiPath, mac, portal, opts);
    if (result) {
      return makeSession(result.token, cached.base, cached.apiPath, portal, mac, opts, kvCache);
    }
    // Path may have changed — clear cache and re-discover
    if (kvCache) await kvCache.delete(key);
  }

  // Discover path: try each base+path combo
  const stripped = portal.replace(/\/+$/, "");
  const bases = [stripped + "/"];
  if (stripped.endsWith("/c")) {
    bases.push(stripped.replace(/\/c$/, "") + "/");
    const root = stripped.replace(/\/[^/]+\/c$/, "");
    if (root !== stripped) bases.push(root + "/");
  } else {
    bases.push(stripped + "/c/");
  }

  for (const base of bases) {
    for (const path of API_PATHS) {
      try {
        const result = await tryHandshake(base, path, mac, portal, opts);
        if (result) {
          // Cache the resolved path in KV (6 hour TTL)
          if (kvCache) {
            await kvCache.put(key, JSON.stringify({ base, apiPath: path }), {
              expirationTtl: 6 * 60 * 60,
            });
          }
          return makeSession(result.token, base, path, portal, mac, opts, kvCache);
        }
      } catch (e) {
        if (e.code === "RATE_LIMITED")
          throw new Error("Portal rate limited (429). Try again in a minute.");
        throw e;
      }
    }
  }
  throw new Error("Handshake failed: could not obtain token from portal");
}

function makeSession(token, base, apiPath, portal, mac, opts, kvCache) {
  return {
    token, base, apiPath, portal, mac, opts,
    headers: stalkerHeaders(mac, token, portal, opts),
    async refresh() {
      return getSession(portal, mac, opts, kvCache);
    },
  };
}

export async function portalFetch(session, params, timeout = 12000) {
  const qs = new URLSearchParams({ ...params, JsHttpRequest: "1-xml" }).toString();
  const url = `${session.base}${session.apiPath}?${qs}`;

  // AbortController for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers: session.headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const text = await res.text();
      if (text.includes("Authorization failed")) return null;
      return JSON.parse(text);
    }
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`Timeout after ${timeout}ms`);
  }

  // Try POST as fallback
  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: session.headers,
      body: qs,
      signal: controller2.signal,
    });
    clearTimeout(timer2);
    if (res.ok) {
      const text = await res.text();
      if (text.includes("Authorization failed")) return null;
      return JSON.parse(text);
    }
  } catch (e) {
    clearTimeout(timer2);
    if (e.name === "AbortError") throw new Error(`Timeout after ${timeout}ms`);
  }

  throw new Error(`Portal request failed: ${params.action || "unknown"}`);
}

export async function portalFetchRetry(session, params, timeout) {
  let result = await portalFetch(session, params, timeout);
  if (result === null) {
    const fresh = await session.refresh();
    Object.assign(session, fresh);
    result = await portalFetch(session, params, timeout);
  }
  if (result === null) throw new Error(`Authorization failed for ${params.action || "unknown"}`);
  return result;
}

export async function fetchAllPages(session, type, category, maxItems = 500) {
  const all = [];

  for (let page = 1; all.length < maxItems; page++) {
    let data;
    try {
      data = await portalFetchRetry(
        session,
        { type, action: "get_ordered_list", category, page, p: page },
        20000
      );
    } catch {
      break;
    }

    const items = data?.js?.data;
    if (!items || !items.length) break;

    all.push(...items);

    const declaredTotal = parseInt(data.js.total_items || data.js.results_num || 0);
    if (declaredTotal > 0 && all.length >= declaredTotal) break;

    const declaredPages = parseInt(data.js.total_pages || data.js.pages_count || 0);
    if (declaredPages > 0 && page >= declaredPages) break;
  }

  return all;
}
