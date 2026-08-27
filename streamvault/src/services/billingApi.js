export function createBillingApi({
  baseUrl = "",
  fetchFn = typeof fetch !== "undefined" ? fetch : null,
  getAuthToken = () => null,
} = {}) {
  const cleanBase = baseUrl.replace(/\/$/, "");

  async function request(endpoint, options = {}) {
    if (!fetchFn) {
      throw new Error("No fetch implementation available");
    }

    const token = getAuthToken ? getAuthToken() : null;
    const headers = {
      ...(options.headers || {}),
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }

    const url = `${cleanBase}${endpoint}`;
    const response = await fetchFn(url, {
      ...options,
      headers,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: response.statusText };
    }

    if (!response.ok) {
      const errorMsg = data?.error || `Request failed with status ${response.status}`;
      const err = new Error(errorMsg);
      err.status = response.status;
      err.code = data?.code || "request_failed";
      err.data = data;
      throw err;
    }

    return data;
  }

  return {
    // Config & Catalog
    getConfig: () => request("/api/billing/config", { method: "GET" }),

    // Orders & History
    listOrders: () => request("/api/billing/orders", { method: "GET" }),
    getHistory: () => request("/api/billing/history", { method: "GET" }),

    // Checkout & Customer Portal
    startCheckout: ({ productCode, acceptedPolicyVersions, acceptedPolicies, returnUrl }) =>
      request("/api/billing/checkout", {
        method: "POST",
        body: {
          productCode,
          acceptedPolicyVersions: acceptedPolicyVersions || acceptedPolicies,
          returnUrl,
        },
      }),

    openCustomerPortal: ({ returnUrl } = {}) =>
      request("/api/billing/portal", {
        method: "POST",
        body: { returnUrl },
      }),

    // Subscription Cancellation
    cancelSubscription: () =>
      request("/api/billing/subscription/cancel", {
        method: "POST",
      }),

    cancelScheduledSubscription: () =>
      request("/api/billing/subscription/scheduled/cancel", {
        method: "POST",
      }),

    // Refunds
    requestRefund: ({ orderId, reason }) =>
      request("/api/billing/refunds", {
        method: "POST",
        body: { orderId, reason },
      }),

    // Support Tickets
    listTickets: () => request("/api/support/tickets", { method: "GET" }),
    createTicket: ({ category, message, orderId }) =>
      request("/api/support/tickets", {
        method: "POST",
        body: { category, message, orderId },
      }),
    getTicket: (ticketId) => request(`/api/support/tickets/${ticketId}`, { method: "GET" }),

    // Connection Access Management
    reconcileConnections: ({ connectionIds = [], clientOrder = [] } = {}) =>
      request("/api/account/connections/reconcile", {
        method: "POST",
        body: { connectionIds, clientOrder },
      }),

    swapConnection: ({ selectConnectionId, deselectConnectionId }) =>
      request("/api/account/connections/select", {
        method: "POST",
        body: { selectConnectionId, deselectConnectionId },
      }),
  };
}
