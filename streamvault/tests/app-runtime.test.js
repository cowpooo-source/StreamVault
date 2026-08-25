import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeJsonFetch, proxyFetch, makeXtreamAPI } from "../src/app-runtime.js";

describe("app-runtime helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should proxy external URLs through the backend proxy", async () => {
    fetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await proxyFetch("https://example.com/live.m3u8");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("/proxy?url=");
  });

  it("should parse JSON responses with safeJsonFetch", async () => {
    await expect(safeJsonFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }))).resolves.toEqual({ ok: true });
  });

  it("should create an Xtream API wrapper that uses the proxy helper", () => {
    const api = makeXtreamAPI("https://portal.test", "u", "p");
    expect(api.auth).toBeTypeOf("function");
    expect(api.getLive).toBeTypeOf("function");
  });
});