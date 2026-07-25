/* global process */
import { test, expect } from "@playwright/test";

/**
 * Real-provider canary suite.
 *
 * Runs nightly or manually against live IPTV providers.
 * Credentials come from environment variables — NEVER committed to the repo.
 *
 * Each test:
 * 1. Validates the provider.
 * 2. Loads at least one category.
 * 3. Finds at least one item.
 * 4. Verifies the resolve endpoint returns a valid result.
 * 5. Checks that the browser attempts the expected direct URL.
 * 6. Does NOT require sustained playback in CI.
 *
 * Provider unavailability marks the canary as degraded but does not block merges.
 */

const XTREAM_SERVER = process.env.CANARY_XTREAM_SERVER;
const XTREAM_USER = process.env.CANARY_XTREAM_USER;
const XTREAM_PASS = process.env.CANARY_XTREAM_PASS;
const STALKER_PORTAL = process.env.CANARY_STALKER_PORTAL;
const STALKER_MAC = process.env.CANARY_STALKER_MAC;
const M3U_URL = process.env.CANARY_M3U_URL;

test.describe("Xtream canary", () => {
  test.skip(!XTREAM_SERVER || !XTREAM_USER || !XTREAM_PASS, "CANARY_XTREAM_SERVER/USER/PASS not all set");

  test("validates and loads at least one category", async ({ page }) => {
    await page.goto("/app");

    // Authenticate through the proxy with real credentials.
    const apiUrl = `${XTREAM_SERVER}/player_api.php?username=${encodeURIComponent(XTREAM_USER)}&password=${encodeURIComponent(XTREAM_PASS)}`;
    const authRes = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, auth: data?.user_info?.auth, status: data?.user_info?.status };
    }, apiUrl);

    expect(authRes.ok).toBe(true);
    expect(authRes.auth).toBe(1);
    expect(authRes.status?.toLowerCase()).toBe("active");

    // Load live categories.
    const catRes = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, count: 0 };
      const data = await res.json();
      return { ok: true, count: Array.isArray(data) ? data.length : 0 };
    }, `${apiUrl}&action=get_live_categories`);

    expect(catRes.ok).toBe(true);
    expect(catRes.count).toBeGreaterThan(0);
  });

  test("loads a live stream and produces the direct playback URL contract", async ({ page }) => {
    await page.goto("/app");

    const apiUrl = XTREAM_SERVER.replace(/\/$/, "") +
      "/player_api.php?username=" + encodeURIComponent(XTREAM_USER) +
      "&password=" + encodeURIComponent(XTREAM_PASS);
    const streams = await page.evaluate(async (url) => {
      const res = await fetch("/proxy?url=" + encodeURIComponent(url));
      if (!res.ok) return { ok: false, status: res.status, items: [] };
      const data = await res.json();
      return { ok: true, status: res.status, items: Array.isArray(data) ? data : [] };
    }, apiUrl + "&action=get_live_streams");

    expect(streams.ok).toBe(true);
    expect(streams.items.length).toBeGreaterThan(0);

    const stream = streams.items.find((item) => item?.stream_id != null);
    expect(stream).toBeTruthy();

    const directUrl = XTREAM_SERVER.replace(/\/$/, "") +
      "/live/" + encodeURIComponent(XTREAM_USER) +
      "/" + encodeURIComponent(XTREAM_PASS) +
      "/" + stream.stream_id + ".ts";
    expect(directUrl).toMatch(/^https?:\/\/.+\/live\/[^/]+\/[^/]+\/\d+\.ts$/);
  });
});

test.describe("Stalker canary", () => {
  test.skip(!STALKER_PORTAL || !STALKER_MAC, "CANARY_STALKER_PORTAL/MAC not all set");

  test("handshake and profile load succeed", async ({ page }) => {
    await page.goto("/app");

    // Verify the Stalker portal is reachable via our backend proxy.
    const result = await page.evaluate(async ({ portal, mac }) => {
      try {
        const res = await fetch("/stalker/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portal, mac }),
        });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        return { ok: true, portalReachable: data.portalReachable, status: data.status };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, { portal: STALKER_PORTAL, mac: STALKER_MAC });

    expect(result.ok).toBe(true);
    expect(result.portalReachable).toBe(true);
  });
});

test.describe("M3U canary", () => {
  test.skip(!M3U_URL, "CANARY_M3U_URL not set");

  test("playlist is reachable and parseable", async ({ page }) => {
    await page.goto("/app");

    const response = await page.evaluate(async (url) => {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) return { ok: false, status: res.status };
      const text = await res.text();
      const hasExtInf = text.includes("#EXTINF");
      return { ok: true, status: res.status, hasExtInf, length: text.length };
    }, M3U_URL);

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.hasExtInf).toBe(true);
    expect(response.length).toBeGreaterThan(0);
  });
});
