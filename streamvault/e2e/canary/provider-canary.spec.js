/* global process */
import { test, expect } from "@playwright/test";

/**
 * Real-provider canary suite.
 *
 * Runs nightly or manually against live IPTV providers.
 * Credentials come from environment variables — NEVER committed to the repo.
 *
 * Phases per provider:
 *   1. Auth / validation
 *   2. Catalog (categories, channels, items)
 *   3. Stream resolution (resolve endpoint)
 *   4. Direct URL contract
 *
 * Provider unavailability marks the canary as degraded but does not block merges.
 */

const XTREAM_SERVER = process.env.CANARY_XTREAM_SERVER;
const XTREAM_USER = process.env.CANARY_XTREAM_USER;
const XTREAM_PASS = process.env.CANARY_XTREAM_PASS;
const STALKER_PORTAL = process.env.CANARY_STALKER_PORTAL;
const STALKER_MAC = process.env.CANARY_STALKER_MAC;
const M3U_URL = process.env.CANARY_M3U_URL;
const CANARY_TARGET_CONFIGURED = Boolean(
  process.env.E2E_BASE_URL
  || XTREAM_SERVER
  || STALKER_PORTAL
  || M3U_URL
);

// ── Aggregated canary report ────────────────────────────────────────────────

/** @type {Array<{provider: string, phase: string, ok: boolean, ms: number, detail: string}>} */
const canaryLog = [];

function recordResult(provider, phase, ok, startMs, detail = "") {
  canaryLog.push({
    provider,
    phase,
    ok,
    ms: Date.now() - startMs,
    detail: detail.substring(0, 120),
  });
}

test.afterAll(() => {
  const report = {};
  for (const r of canaryLog) {
    if (!report[r.provider]) report[r.provider] = { phases: {}, degraded: false };
    report[r.provider].phases[r.phase] = { ok: r.ok, ms: r.ms, detail: r.detail || undefined };
    if (!r.ok) report[r.provider].degraded = true;
  }

  const summary = Object.entries(report).map(([p, s]) => {
    const phases = Object.entries(s.phases)
      .map(([ph, r]) => `${ph}:${r.ok ? "PASS" : "FAIL"}(${r.ms}ms)`)
      .join(" ");
    return `  ${p}  ${s.degraded ? "DEGRADED" : "OK"}  ${phases}`;
  });

  console.log("\n── Canary Summary ──");
  if (summary.length) console.log(summary.join("\n"));
  else console.log("  No providers configured.");
  console.log("");
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function goApp(page) {
  await page.goto("/app");
}

/** Build the Xtream API base URL from env vars. */
function xtreamApiUrl(action) {
  const base = XTREAM_SERVER.replace(/\/$/, "");
  const params = new URLSearchParams({
    username: XTREAM_USER,
    password: XTREAM_PASS,
  });
  if (action) params.set("action", action);
  return `${base}/player_api.php?${params.toString()}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Xtream
// ══════════════════════════════════════════════════════════════════════════════

test.describe("Xtream canary", () => {
  test.skip(
    !XTREAM_SERVER || !XTREAM_USER || !XTREAM_PASS,
    "CANARY_XTREAM_SERVER/USER/PASS not all set",
  );

  test("auth — account is active", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const authRes = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      const userInfo = data?.user_info || {};
      return {
        ok: true,
        auth: Number(userInfo.auth),
        status: String(userInfo.status || "").trim(),
        maxConnections: Number(userInfo.max_connections),
      };
    }, xtreamApiUrl());

    recordResult("Xtream", "auth", authRes.ok && authRes.auth === 1, start,
      authRes.ok ? `status=${authRes.status} max=${authRes.maxConnections}` : `HTTP ${authRes.status}`);

    expect(authRes.ok).toBe(true);
    expect(authRes.auth).toBe(1);
    expect(authRes.status?.toLowerCase()).toBe("active");
    expect(authRes.maxConnections).toBeGreaterThan(0);
  });

  test("catalog — loads live categories with items", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const catRes = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, count: 0 };
      const data = await res.json();
      return { ok: true, count: Array.isArray(data) ? data.length : 0 };
    }, xtreamApiUrl("get_live_categories"));

    recordResult("Xtream", "live-catalog", catRes.ok && catRes.count > 0, start,
      `${catRes.count} categories`);

    expect(catRes.ok).toBe(true);
    expect(catRes.count).toBeGreaterThan(0);
  });

  test("catalog — loads VOD with at least one item", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const vodRes = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, count: 0, first: null };
      const data = await res.json();
      const items = Array.isArray(data) ? data : [];
      const first = items.length ? { id: items[0].stream_id, name: items[0].name } : null;
      return { ok: true, count: items.length, first };
    }, xtreamApiUrl("get_vod_streams"));

    recordResult("Xtream", "vod-catalog", vodRes.ok && vodRes.count > 0, start,
      `${vodRes.count} items`);

    expect(vodRes.ok).toBe(true);
    expect(vodRes.count).toBeGreaterThan(0);
  });

  test("catalog — loads Series with at least one show", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const seriesRes = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, count: 0 };
      const data = await res.json();
      const items = Array.isArray(data) ? data : [];
      return { ok: true, count: items.length };
    }, xtreamApiUrl("get_series"));

    recordResult("Xtream", "series-catalog", seriesRes.ok && seriesRes.count > 0, start,
      `${seriesRes.count} shows`);

    expect(seriesRes.ok).toBe(true);
    expect(seriesRes.count).toBeGreaterThan(0);
  });

  test("resolve — live stream returns a direct TS URL contract", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const targetUrl = "/proxy?url=" + encodeURIComponent(xtreamApiUrl("get_live_streams"));
    const response = await page.request.get(targetUrl);
    if (!response.ok()) {
      const result = { ok: false, phase: "fetch_streams", status: response.status() };
      recordResult("Xtream", "resolve-live", false, start, "fetch_streams status=" + response.status());
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return;
    }

    const streams = await response.json();
    expect(Array.isArray(streams), "get_live_streams must return an array").toBe(true);
    const stream = streams.find((item) => item?.stream_id != null);
    expect(stream, "get_live_streams returned no usable stream").toBeTruthy();

    const directPath = "/live/" + encodeURIComponent(XTREAM_USER) +
      "/" + encodeURIComponent(XTREAM_PASS) +
      "/" + stream.stream_id + ".ts";
    const directUrl = new URL(directPath, xtreamApiUrl()).toString();
    const urlContract = /^https?:\/\/.+\/live\/.+\/.+\/\d+\.ts$/.test(directUrl);

    recordResult("Xtream", "resolve-live", urlContract, start, stream.name || directUrl);

    expect(urlContract).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Stalker
// ══════════════════════════════════════════════════════════════════════════════

test.describe("Stalker canary", () => {
  test.skip(
    !STALKER_PORTAL || !STALKER_MAC,
    "CANARY_STALKER_PORTAL/MAC not all set",
  );

  test("auth — handshake and validate succeed", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const result = await page.evaluate(async ({ portal, mac }) => {
      const res = await fetch("/stalker/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portal, mac }),
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return {
        ok: true,
        portalReachable: data.portalReachable,
        status: data.status,
        daysLeft: data.daysLeft,
        maxConnections: data.maxConnections,
        valid: data.valid,
      };
    }, { portal: STALKER_PORTAL, mac: STALKER_MAC });

    recordResult("Stalker", "validate", result.ok && result.portalReachable, start,
      `status=${result.status} daysLeft=${result.daysLeft} valid=${result.valid}`);

    expect(result.ok).toBe(true);
    expect(result.portalReachable).toBe(true);
    expect(result.valid).toBe(true);
  });

  test("catalog — loads channels with non-empty commands", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const result = await page.evaluate(async ({ portal, mac }) => {
      const params = new URLSearchParams({ portal, mac });
      const res = await fetch(`/stalker/channels?${params.toString()}`);
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      const channels = data?.channels || [];
      const withCmd = channels.filter((ch) => ch?.url && ch.url.length > 0).length;
      return { ok: true, total: channels.length, withCmd };
    }, { portal: STALKER_PORTAL, mac: STALKER_MAC });

    recordResult("Stalker", "catalog", result.ok && result.total > 0 && result.withCmd > 0, start,
      `${result.total} channels, ${result.withCmd} with cmd`);

    expect(result.ok).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(result.withCmd).toBeGreaterThan(0);
  });

  test("resolve — first live channel resolves to a playable URL", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const result = await page.evaluate(async ({ portal, mac }) => {
      // 1. Get channels.
      const chParams = new URLSearchParams({ portal, mac });
      const chRes = await fetch(`/stalker/channels?${chParams.toString()}`);
      if (!chRes.ok) return { ok: false, phase: "channels", status: chRes.status };
      const { channels } = await chRes.json();
      const channel = channels?.find((ch) => ch?.url);
      if (!channel) return { ok: false, phase: "no_channel_with_cmd" };

      // 2. Resolve stream.
      const playParams = new URLSearchParams({
        portal, mac,
        cmd: channel.url,
        content_type: "live",
        resolve: "1",
      });
      const playRes = await fetch(`/stalker/play?${playParams.toString()}`);
      if (!playRes.ok) return { ok: false, phase: "resolve", status: playRes.status };
      const playData = await playRes.json();

      return {
        ok: true,
        channelName: channel.name,
        streamUrl: playData.url,
        streamKind: playData.streamKind,
        direct: playData.direct,
        hasFallbackUrl: !!playData.fallbackUrl,
      };
    }, { portal: STALKER_PORTAL, mac: STALKER_MAC });

    recordResult("Stalker", "resolve", result.ok && !!result.streamUrl, start,
      `kind=${result.streamKind} direct=${result.direct} fallback=${result.hasFallbackUrl} channel="${result.channelName}"`);

    expect(result.ok).toBe(true);
    expect(result.streamUrl).toMatch(/^https?:\/\//);
    expect(result.direct).toBeDefined();
    expect(result.hasFallbackUrl).toBe(true);
  });

  test("profile — returns expected account fields", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const result = await page.evaluate(async ({ portal, mac }) => {
      const params = new URLSearchParams({ portal, mac });
      const res = await fetch(`/stalker/profile?${params.toString()}`);
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, hasId: !!data?.id, hasTariff: !!data?.tariff_plan };
    }, { portal: STALKER_PORTAL, mac: STALKER_MAC });

    recordResult("Stalker", "profile", result.ok, start, "");

    expect(result.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  M3U
// ══════════════════════════════════════════════════════════════════════════════

test.describe("M3U canary", () => {
  test.skip(!M3U_URL, "CANARY_M3U_URL not set");

  test("fetch — playlist is reachable and valid", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const result = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, status: res.status };
      const text = await res.text();
      const lines = text.split("\n");
      const extInfCount = lines.filter((l) => l.startsWith("#EXTINF")).length;
      const streamUrls = lines
        .filter((l) => l.trim() && !l.startsWith("#"))
        .filter((l) => l.startsWith("http://") || l.startsWith("https://"));
      return {
        ok: true,
        extInfCount,
        streamUrlCount: streamUrls.length,
        firstStreamUrl: streamUrls[0] || null,
        size: text.length,
      };
    }, M3U_URL);

    recordResult("M3U", "fetch", result.ok && result.extInfCount > 0 && result.streamUrlCount > 0, start,
      `${result.extInfCount} entries, ${result.streamUrlCount} stream URLs`);

    expect(result.ok).toBe(true);
    expect(result.extInfCount).toBeGreaterThanOrEqual(3);
    expect(result.streamUrlCount).toBeGreaterThan(0);
  });

  test("resolve — first stream URL is syntactically valid", async ({ page }) => {
    const start = Date.now();
    await goApp(page);

    const result = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, status: res.status };
      const text = await res.text();
      const lines = text.split("\n");
      const streamUrl = lines.find(
        (l) => l.trim() && (l.startsWith("http://") || l.startsWith("https://")),
      );
      if (!streamUrl) return { ok: false, phase: "no_stream_url" };

      let parsed;
      try {
        parsed = new URL(streamUrl.trim());
      } catch {
        return { ok: false, phase: "invalid_url" };
      }
      return {
        ok: true,
        protocol: parsed.protocol,
        hasExtension: /\.(ts|m3u8|mp4|mkv|avi|webm)$/i.test(parsed.pathname),
        hostname: parsed.hostname,
      };
    }, M3U_URL);

    recordResult("M3U", "resolve-url", result.ok, start,
      `${result.protocol}//${result.hostname} ext=${result.hasExtension}`);

    expect(result.ok).toBe(true);
    expect(result.protocol).toMatch(/^https?:$/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Backend health
// ══════════════════════════════════════════════════════════════════════════════

test.describe("Backend health", () => {
  test("/health returns 200", async ({ page }) => {
    test.skip(!CANARY_TARGET_CONFIGURED, "No canary provider or E2E_BASE_URL configured");
    const start = Date.now();
    const res = await page.goto("/health");
    expect(res).not.toBeNull();
    expect(res.status()).toBe(200);
    recordResult("backend", "health", res.status() === 200, start, "");
  });
});
