import {
  categorizeIptvError,
  createIptvError,
  iptvErrorMessage,
  isRetryableIptvError,
  normalizeIptvError,
} from "../src/iptv-errors.js";

describe("IPTV error normalization", () => {
  it.each([
    [401, "unauthorized"], [403, "blocked"], [404, "not_found"],
    [429, "rate_limited"], [456, "provider_rejected"], [459, "expired"],
    [502, "provider_unavailable"],
  ])("maps HTTP %s to %s", (status, category) => {
    expect(categorizeIptvError({ status })).toBe(category);
  });

  it("maps browser and media failures", () => {
    expect(categorizeIptvError("Access-Control-Allow-Origin missing")).toBe("browser_policy");
    expect(categorizeIptvError("FormatUnsupported")).toBe("unsupported_format");
    expect(categorizeIptvError("ERR_CONNECTION_RESET")).toBe("network");
  });

  it("marks terminal and retryable failures correctly", () => {
    expect(normalizeIptvError({ status: 404 }).terminal).toBe(true);
    expect(isRetryableIptvError({ status: 502 })).toBe(true);
    expect(isRetryableIptvError({ status: 429 })).toBe(false);
    expect(isRetryableIptvError({ status: 429 }, { allowRateLimit: true })).toBe(true);
  });

  it("preserves a normalized error contract and safe message", () => {
    const error = createIptvError({ status: 456, error: "provider rejected" });
    expect(error).toMatchObject({ category: "provider_rejected", status: 456, terminal: true });
    expect(iptvErrorMessage(error)).toContain("456");
  });
});
