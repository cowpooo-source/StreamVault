import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBillingApi } from "../src/services/billingApi.js";

describe("billingApi frontend client", () => {
  let mockFetch;
  let api;

  beforeEach(() => {
    mockFetch = vi.fn();
    api = createBillingApi({
      baseUrl: "https://media.portalheaven.stream",
      fetchFn: mockFetch,
      getAuthToken: () => "mock-jwt-token",
    });
  });

  it("getConfig fetches /api/billing/config", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        enabled: true,
        products: [{ code: "standard_pass_30d", name: "Standard 30-Day Pass" }],
        policies: { terms: { version: "v1" } },
      }),
    });

    const config = await api.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.products.length).toBe(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://media.portalheaven.stream/api/billing/config",
      expect.objectContaining({
        method: "GET",
      })
    );
  });

  it("startCheckout posts acceptedPolicyVersions and returns checkoutUrl", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        checkoutUrl: "https://checkout.stripe.com/pay/cs_test_123",
        orderId: "ord_123",
        mode: "payment",
      }),
    });

    const res = await api.startCheckout({
      productCode: "standard_pass_30d",
      acceptedPolicyVersions: { terms: "v1", privacy: "v1", refund: "v1" },
      returnUrl: "/app?settingsTab=billing",
    });

    expect(res.checkoutUrl).toBe("https://checkout.stripe.com/pay/cs_test_123");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://media.portalheaven.stream/api/billing/checkout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer mock-jwt-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          productCode: "standard_pass_30d",
          acceptedPolicyVersions: { terms: "v1", privacy: "v1", refund: "v1" },
          returnUrl: "/app?settingsTab=billing",
        }),
      })
    );
  });

  it("openCustomerPortal posts to /api/billing/portal", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ portalUrl: "https://billing.stripe.com/session/123" }),
    });

    const res = await api.openCustomerPortal({ returnUrl: "/app?settingsTab=billing" });
    expect(res.portalUrl).toBe("https://billing.stripe.com/session/123");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://media.portalheaven.stream/api/billing/portal",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("cancelSubscription and cancelScheduledSubscription post to respective endpoints", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, cancelAtPeriodEnd: true }) });
    const cancelRes = await api.cancelSubscription();
    expect(cancelRes.ok).toBe(true);

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, canceled: true }) });
    const schedRes = await api.cancelScheduledSubscription();
    expect(schedRes.ok).toBe(true);
  });

  it("requestRefund posts orderId to /api/billing/refunds", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: "refund_pending" }) });

    const res = await api.requestRefund({ orderId: "ord_123", reason: "Customer request" });
    expect(res.status).toBe("refund_pending");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://media.portalheaven.stream/api/billing/refunds",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orderId: "ord_123", reason: "Customer request" }),
      })
    );
  });

  it("support ticket functions list and create tickets", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tickets: [{ id: "tkt_1", category: "billing" }] }),
    });

    const list = await api.listTickets();
    expect(list.tickets.length).toBe(1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticketId: "tkt_2", status: "open" }),
    });

    const created = await api.createTicket({
      category: "playback",
      message: "Streaming buffer issue on channel 12.",
    });
    expect(created.ticketId).toBe("tkt_2");
  });

  it("reconcileConnections and swapConnection interact with connection access endpoints", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ connections: [{ connectionId: "c1", status: "active" }], maxActive: 2 }),
    });

    const recon = await api.reconcileConnections({ connectionIds: ["c1"] });
    expect(recon.connections.length).toBe(1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, swapped: true }),
    });

    const swap = await api.swapConnection({
      selectConnectionId: "c2",
      deselectConnectionId: "c1",
    });
    expect(swap.swapped).toBe(true);
  });

  it("throws formatted error when backend responds with non-2xx", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid agreement version", code: "invalid_agreement" }),
    });

    await expect(
      api.startCheckout({
        productCode: "standard_pass_30d",
        acceptedPolicyVersions: { terms: "v0" },
      })
    ).rejects.toThrow("Invalid agreement version");
  });
});
