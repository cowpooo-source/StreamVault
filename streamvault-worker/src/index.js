// StreamVault CF Worker — main router
// Replaces stalker-proxy + existing CF Pages worker
import { jsonResponse, handleOptions } from "./utils/cors.js";
import {
  handleHandshake, handleChannels, handleVodCategories, handleVod,
  handleSeriesCategories, handleSeries, handleSeriesSeasons,
  handleStalkerStream, handleEpisodeStream, handleStalkerPlay,
  handleProfile, handleAccount, handleEpg, handleApi,
} from "./handlers/stalker.js";
import { handleStream, handleStreamHead } from "./handlers/stream.js";
import { handleProxy } from "./handlers/proxy.js";
import { handleCleanup } from "./handlers/cleanup.js";
import { handleAnalytics, handleDashboardHTML } from "./handlers/analytics.js";
import {
  handlePutContent, handleGetContent, handleDeleteContent,
  handlePutConnection, handleGetConnections, handleDeleteConnection,
  handlePutCategories, handleGetCategories,
  handleGetFavorites, handlePutFavorites,
  handleGetHistory, handlePutHistory, handlePatchHistory,
  handleGetPreferences, handlePutPreferences,
  handleGetSyncStatus,
} from "./handlers/catalog.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight for all routes
    if (method === "OPTIONS") return handleOptions();

    // Track daily request count (fire-and-forget, non-blocking)
    const today = new Date().toISOString().slice(0, 10);
    const isStream = pathname === "/stream" || pathname.startsWith("/stalker/play");
    ctx.waitUntil(
      env.SV_DB.prepare(
        "INSERT INTO usage_log (date, metric, value) VALUES (?, ?, 1) ON CONFLICT(date, metric) DO UPDATE SET value = value + 1"
      ).bind(today, isStream ? "cf_stream_requests" : "cf_api_requests").run().catch(() => {})
    );

    // Health check
    if (pathname === "/health") {
      return jsonResponse({ status: "ok", runtime: "cloudflare-worker" });
    }

    // ── Stream proxy
    if (pathname === "/stream") {
      if (method === "HEAD") return handleStreamHead(url);
      if (method === "GET") return handleStream(url);
    }

    // ── Generic CORS proxy (Xtream API, M3U fetches)
    if (pathname === "/proxy" && method === "GET") {
      return handleProxy(url);
    }

    // ── Catalog API (persistent D1 storage)
    if (pathname === "/api/catalog/content") {
      if (method === "PUT") return handlePutContent(request, env);
      if (method === "GET") return handleGetContent(request, env, url);
      if (method === "DELETE") return handleDeleteContent(request, env, url);
    }
    if (pathname === "/api/catalog/connections") {
      if (method === "PUT") return handlePutConnection(request, env);
      if (method === "GET") return handleGetConnections(request, env);
      if (method === "DELETE") return handleDeleteConnection(request, env, url);
    }
    if (pathname === "/api/catalog/categories") {
      if (method === "PUT") return handlePutCategories(request, env);
      if (method === "GET") return handleGetCategories(request, env, url);
    }
    if (pathname === "/api/catalog/favorites") {
      if (method === "GET") return handleGetFavorites(request, env, url);
      if (method === "PUT") return handlePutFavorites(request, env);
    }
    if (pathname === "/api/catalog/history") {
      if (method === "GET") return handleGetHistory(request, env);
      if (method === "PUT") return handlePutHistory(request, env);
      if (method === "PATCH") return handlePatchHistory(request, env);
    }
    if (pathname === "/api/catalog/preferences") {
      if (method === "GET") return handleGetPreferences(request, env);
      if (method === "PUT") return handlePutPreferences(request, env);
    }
    if (pathname === "/api/catalog/sync-status") {
      if (method === "GET") return handleGetSyncStatus(request, env, url);
    }

    // ── Stalker routes
    if (pathname === "/stalker/handshake" && method === "POST") {
      return handleHandshake(request, env);
    }
    if (pathname === "/stalker/channels" && method === "GET") {
      return handleChannels(url, env);
    }
    if (pathname === "/stalker/vod/categories" && method === "GET") {
      return handleVodCategories(url, env);
    }
    if (pathname === "/stalker/vod" && method === "GET") {
      return handleVod(url, env);
    }
    if (pathname === "/stalker/series/categories" && method === "GET") {
      return handleSeriesCategories(url, env);
    }
    if (pathname === "/stalker/series/episode/stream" && method === "GET") {
      return handleEpisodeStream(url, env);
    }
    if (pathname === "/stalker/series/seasons" && method === "GET") {
      return handleSeriesSeasons(url, env);
    }
    if (pathname === "/stalker/series" && method === "GET") {
      return handleSeries(url, env);
    }
    if (pathname === "/stalker/play" && method === "GET") {
      return handleStalkerPlay(url, env);
    }
    if (pathname === "/stalker/stream" && method === "GET") {
      return handleStalkerStream(url, env);
    }
    if (pathname === "/stalker/profile" && method === "GET") {
      return handleProfile(url, env);
    }
    if (pathname === "/stalker/account" && method === "GET") {
      return handleAccount(url, env);
    }
    if (pathname === "/stalker/epg" && method === "GET") {
      return handleEpg(url, env);
    }
    if (pathname === "/stalker/api" && method === "GET") {
      return handleApi(url, env);
    }

    // Manual cleanup trigger (admin)
    if (pathname === "/api/cleanup" && method === "POST") {
      const result = await handleCleanup(env);
      return jsonResponse(result);
    }

    // Analytics
    if (pathname === "/api/analytics" && method === "GET") {
      return handleAnalytics(request, env, url);
    }
    if (pathname === "/analytics" && method === "GET") {
      return handleDashboardHTML();
    }

    // 404
    return jsonResponse({ error: "Not found" }, 404);
  },

  // Cron trigger — runs daily at 3am UTC
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCleanup(env));
  },
};
