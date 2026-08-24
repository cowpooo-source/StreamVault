import { beforeEach, describe, expect, it, vi } from "vitest";

describe("privacy-safe analytics", () => {
  let analytics;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST123");
    window.history.replaceState({}, "", "/");
    localStorage.clear();
    const values = new Map();
    localStorage.getItem.mockImplementation(key => values.get(key) ?? null);
    localStorage.setItem.mockImplementation((key, value) => values.set(key, String(value)));
    localStorage.removeItem.mockImplementation(key => values.delete(key));
    localStorage.clear.mockImplementation(() => values.clear());
    globalThis.dataLayer = [];
    globalThis.gtag = vi.fn();
    analytics = await import("../src/analytics.js");
  });

  it("does not emit events without explicit consent", () => {
    const { getAnalyticsConsent, trackAnalytics } = analytics;
    expect(getAnalyticsConsent()).toBeNull();
    expect(trackAnalytics("portal_connect", { provider_type: "xtream" })).toBe(false);
    expect(globalThis.gtag).not.toHaveBeenCalledWith("event", expect.anything(), expect.anything());
  });

  it("reports analytics as available when the frontend GA ID is configured", () => {
    expect(analytics.isAnalyticsAvailable()).toBe(true);

    analytics.initializeAnalytics();

    expect(globalThis.gtag).toHaveBeenCalledWith("consent", "default", expect.objectContaining({
      analytics_storage: "denied",
    }));
  });

  it("updates consent and emits only sanitized dimensions", () => {
    const { setAnalyticsConsent, trackAnalytics } = analytics;
    setAnalyticsConsent("granted");
    const emitted = trackAnalytics("portal_connect", {
      provider_type: "xtream",
      success: true,
      latency_ms: 123.8,
      server_url: "http://provider.example/user/pass",
      error_code: "https://provider.example?token=secret",
      username: "customer@example.com",
    });

    expect(emitted).toBe(true);
    expect(globalThis.gtag).toHaveBeenCalledWith("event", "portal_connect", {
      provider_type: "xtream",
      success: true,
      latency_ms: 124,
      failure_category: "unknown",
    });
  });

  it("sets denied consent by default before loading analytics", () => {
    const { initializeAnalytics } = analytics;
    initializeAnalytics();
    expect(globalThis.gtag).toHaveBeenCalledWith("consent", "default", expect.objectContaining({
      analytics_storage: "denied",
      ad_storage: "denied",
    }));
  });

  it("removes query parameters from the configured page location", () => {
    const { setAnalyticsConsent } = analytics;
    window.history.replaceState({}, "", "/content?token=secret");
    setAnalyticsConsent("granted");

    expect(globalThis.gtag).toHaveBeenCalledWith("config", "G-TEST123", expect.objectContaining({
      page_location: `${location.origin}/content`,
    }));
  });

  it("categorizes provider errors without retaining raw messages", () => {
    const { categorizeAnalyticsError } = analytics;
    expect(categorizeAnalyticsError("HTTP 456 from provider")).toBe("provider_rejected");
    expect(categorizeAnalyticsError("Request timed out")).toBe("timeout");
    expect(categorizeAnalyticsError("CORS blocked")).toBe("browser_policy");
    expect(categorizeAnalyticsError("Invalid credentials")).toBe("invalid_credentials");
  });

  it("drops URLs, identifiers, and unsafe strings", () => {
    const { sanitizeAnalyticsPayload } = analytics;
    expect(sanitizeAnalyticsPayload({
      screen: "live",
      content_id: "123",
      portal: "http://secret.example",
      email: "person@example.com",
      category: "Adults",
      reason: "network",
    })).toEqual({ screen: "live", reason: "network" });
  });
});
