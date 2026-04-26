// Stalker portal API handlers — all routes under /stalker/*
import { jsonResponse, errorResponse } from "../utils/cors.js";
import { getSession, portalFetchRetry, fetchAllPages } from "../utils/stalker.js";

// Some portals return stream URLs with "localhost" — replace with portal hostname
function fixLocalhost(streamUrl, portal) {
  if (!streamUrl.includes("localhost") && !streamUrl.includes("127.0.0.1")) return streamUrl;
  try {
    const portalHost = new URL(portal).host;
    return streamUrl
      .replace(/localhost(:\d+)?/g, portalHost)
      .replace(/127\.0\.0\.1(:\d+)?/g, portalHost);
  } catch { return streamUrl; }
}

// POST /stalker/handshake
export async function handleHandshake(request, env) {
  const { portal, mac, serial } = await request.json();
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  try {
    const session = await getSession(portal, mac, { serial }, env.SV_CACHE);
    return jsonResponse({ token: session.token });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/channels?portal=...&mac=...
export async function handleChannels(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);

    const genreData = await portalFetchRetry(session, { type: "itv", action: "get_genres" }, 10000);
    const chData = await portalFetchRetry(session, { type: "itv", action: "get_all_channels" }, 15000);

    const genres = genreData?.js || [];
    const genreMap = Object.fromEntries(genres.map((g) => [g.id, g.title]));
    const channels = chData?.js?.data || [];

    const result = channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      num: ch.number,
      logo: ch.logo || ch.icon || null,
      group: genreMap[ch.tv_genre_id] || "Other",
      url: ch.cmd || null,
      epgId: ch.xmltv_id || null,
      type: "live",
    }));

    return jsonResponse({ channels: result, total: result.length });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/vod/categories?portal=...&mac=...
export async function handleVodCategories(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const catData = await portalFetchRetry(session, { type: "vod", action: "get_categories" }, 10000);
    const categories = (catData?.js || []).map((c) => ({
      id: String(c.id),
      title: c.title,
      count: parseInt(c.count || c.videos_count || c.censored_count || 0),
    }));
    return jsonResponse({ categories });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/vod?portal=...&mac=...&cat=ID
export async function handleVod(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const cat = url.searchParams.get("cat");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);
  if (!cat) return errorResponse("cat (category id) required", 400);

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const rawItems = await fetchAllPages(session, "vod", cat);

    const items = rawItems.map((v) => ({
      id: v.id,
      name: v.name,
      logo: v.screenshot_uri || v.cover || null,
      year: v.year,
      rating: v.rating_imdb || v.rating || null,
      url: v.cmd || null,
      type: "vod",
    }));

    return jsonResponse({ items, total: items.length });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/series/categories?portal=...&mac=...
export async function handleSeriesCategories(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const catData = await portalFetchRetry(session, { type: "series", action: "get_categories" }, 10000);
    const categories = (catData?.js || []).map((c) => ({
      id: String(c.id),
      title: c.title,
      count: parseInt(c.count || c.videos_count || c.censored_count || 0),
    }));
    return jsonResponse({ categories });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/series?portal=...&mac=...&cat=ID
export async function handleSeries(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const cat = url.searchParams.get("cat");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);
  if (!cat) return errorResponse("cat (category id) required", 400);

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const rawItems = await fetchAllPages(session, "series", cat);

    const items = rawItems.map((s) => ({
      id: s.id,
      name: s.name,
      logo: s.screenshot_uri || s.cover || null,
      year: s.year,
      rating: s.rating_imdb || s.rating || null,
      type: "series",
    }));

    return jsonResponse({ items, total: items.length });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/series/seasons?portal=...&mac=...&seriesId=ID
export async function handleSeriesSeasons(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const seriesId = url.searchParams.get("seriesId");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);
  if (!seriesId) return errorResponse("seriesId required", 400);

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const movieId = seriesId.split(":")[0];
    const data = await portalFetchRetry(
      session,
      { type: "series", action: "get_ordered_list", movie_id: movieId, page: 1, p: 1 },
      20000
    );

    const rawSeasons = data?.js?.data || [];
    const seasons = rawSeasons.map((s) => ({
      id: s.id,
      name: s.name,
      cmd: s.cmd || "",
      episodes: Array.isArray(s.series) ? s.series : [],
      logo: s.screenshot_uri || s.cover || null,
    }));

    return jsonResponse({ seasons });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/stream?portal=...&mac=...&cmd=...&content_type=...
export async function handleStalkerStream(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const cmd = url.searchParams.get("cmd");
  const contentType = url.searchParams.get("content_type") || "live";
  if (!portal || !mac || !cmd) return errorResponse("portal, mac and cmd required", 400);

  const stalkerType = contentType === "vod" || contentType === "series" ? "vod" : "itv";

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const data = await portalFetchRetry(session, {
      type: stalkerType,
      action: "create_link",
      cmd,
      series: 0,
      forced_storage: 0,
      disable_ad: 0,
      download: 0,
      force_ch_link_check: 0,
    });

    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned");

    const cleanUrl = fixLocalhost(streamUrl.replace(/^ffmpeg\s+/, "").trim(), portal);
    return jsonResponse({ url: cleanUrl });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/series/episode/stream?portal=...&mac=...&cmd=...&episode=...
export async function handleEpisodeStream(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const cmd = url.searchParams.get("cmd");
  const episode = url.searchParams.get("episode");
  if (!portal || !mac || !cmd || !episode) {
    return errorResponse("portal, mac, cmd and episode required", 400);
  }

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const data = await portalFetchRetry(session, {
      type: "vod",
      action: "create_link",
      cmd,
      series: episode,
      forced_storage: 0,
      disable_ad: 0,
      download: 0,
      force_ch_link_check: 0,
    });

    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned for episode");

    const cleanUrl = fixLocalhost(streamUrl.replace(/^ffmpeg\s+/, "").trim(), portal);
    return jsonResponse({ url: cleanUrl });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/profile?portal=...&mac=...&serial=...&deviceId=...&deviceId2=...
export async function handleProfile(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const serial = url.searchParams.get("serial");
  const deviceId = url.searchParams.get("deviceId");
  const deviceId2 = url.searchParams.get("deviceId2");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  try {
    const session = await getSession(portal, mac, { serial }, env.SV_CACHE);
    const params = {
      type: "stb",
      action: "get_profile",
      auth_second_step: 1,
      hw_version_2: "8b80dfaa8cf83485567849b7202a79360fc988e3",
    };
    if (serial) params.sn = serial;
    if (deviceId) params.device_id = deviceId;
    if (deviceId2 || deviceId) params.device_id2 = deviceId2 || deviceId;
    const data = await portalFetchRetry(session, params);
    return jsonResponse(data?.js || {});
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/account?portal=...&mac=...
export async function handleAccount(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const data = await portalFetchRetry(session, {
      type: "account_info",
      action: "get_main_info",
    });
    return jsonResponse(data?.js || {});
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/epg?portal=...&mac=...&period=N
export async function handleEpg(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const period = url.searchParams.get("period") || "4";
  const serial = url.searchParams.get("serial");
  const deviceId = url.searchParams.get("deviceId");
  const deviceId2 = url.searchParams.get("deviceId2");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  try {
    const session = await getSession(portal, mac, { serial, deviceId, deviceId2 }, env.SV_CACHE);
    const data = await portalFetchRetry(
      session,
      { type: "itv", action: "get_epg_info", period },
      20000
    );

    const programs = {};
    const epgData = data?.js?.data || data?.js || {};
    for (const [channelId, shows] of Object.entries(epgData)) {
      if (!Array.isArray(shows)) continue;
      programs[channelId] = shows.map((s) => ({
        title: s.name || s.title || "",
        start: (s.start_timestamp || s.start || 0) * 1000,
        stop: (s.stop_timestamp || s.stop || 0) * 1000,
      }));
    }

    return jsonResponse({ programs });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/play?portal=...&mac=...&cmd=...&content_type=...&episode=...
// Combined: resolves create_link AND streams in ONE request (same Worker invocation = same IP)
// This avoids the 403 caused by IP mismatch between separate create_link and /stream calls
export async function handleStalkerPlay(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  const cmd = url.searchParams.get("cmd");
  const contentType = url.searchParams.get("content_type") || "live";
  const episode = url.searchParams.get("episode");
  if (!portal || !mac || !cmd) return errorResponse("portal, mac and cmd required", 400);

  const stalkerType = contentType === "vod" || contentType === "series" ? "vod" : "itv";

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const linkParams = {
      type: stalkerType,
      action: "create_link",
      cmd,
      series: episode || 0,
      forced_storage: 0,
      disable_ad: 0,
      download: 0,
      force_ch_link_check: 0,
    };
    const data = await portalFetchRetry(session, linkParams);

    const streamUrl = data?.js?.cmd;
    if (!streamUrl) throw new Error("No stream URL returned");

    const cleanUrl = fixLocalhost(streamUrl.replace(/^ffmpeg\s+/, "").trim(), portal);

    // Fetch the stream in the SAME Worker invocation (same outbound IP as create_link)
    const upstream = await fetch(cleanUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
        "Cookie": `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe%2FParis`,
      },
      redirect: "follow",
    });

    if (!upstream.ok) {
      // Stream fetch failed (e.g. CF-to-CF block, IP mismatch)
      // Return the resolved URL as JSON so the SPA can try alternate playback
      return jsonResponse({ url: cleanUrl, fallback: true }, 200);
    }

    const ct = upstream.headers.get("content-type") || "";
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range",
    };

    // HLS manifest — rewrite segment URLs to go through /stream
    if (ct.includes("mpegurl") || cleanUrl.includes(".m3u8")) {
      let body = await upstream.text();
      body = body.replace(/^(http:\/\/[^\s]+)/gm, (match) =>
        `${url.origin}/stream?url=${encodeURIComponent(match)}`
      );
      headers["Content-Type"] = "application/vnd.apple.mpegurl";
      return new Response(body, { status: 200, headers });
    }

    if (ct) headers["Content-Type"] = ct;
    const cl = upstream.headers.get("content-length");
    if (cl) headers["Content-Length"] = cl;

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return errorResponse(e.message);
  }
}

// GET /stalker/api?portal=...&mac=...&type=...&action=... (generic passthrough)
export async function handleApi(url, env) {
  const portal = url.searchParams.get("portal");
  const mac = url.searchParams.get("mac");
  if (!portal || !mac) return errorResponse("portal and mac required", 400);

  const apiParams = {};
  for (const [key, val] of url.searchParams.entries()) {
    if (key !== "portal" && key !== "mac") apiParams[key] = val;
  }

  try {
    const session = await getSession(portal, mac, {}, env.SV_CACHE);
    const data = await portalFetchRetry(session, apiParams);
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e.message);
  }
}
