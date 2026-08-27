import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AccountSettingsModal from "../src/components/AccountSettingsModal.jsx";

describe("AccountSettingsModal Component", () => {
  let mockBillingApi;
  let mockAccessState;

  beforeEach(() => {
    mockAccessState = {
      role: "regular",
      plan: "standard",
      planSource: "paid",
      billingStatus: "active",
      limits: { maxConnections: 5, maxLogins: 3 },
    };

    mockBillingApi = {
      getConfig: vi.fn().mockResolvedValue({ enabled: true, products: [], policies: {} }),
      listOrders: vi.fn().mockResolvedValue({ orders: [] }),
      listTickets: vi.fn().mockResolvedValue({ tickets: [] }),
      reconcileConnections: vi.fn().mockResolvedValue({ connections: [], maxActive: 5 }),
    };
  });

  it("renders with tab navigation (Account, Billing, Connections, Support)", () => {
    const onClose = vi.fn();
    render(
      <AccountSettingsModal
        isOpen={true}
        onClose={onClose}
        accessState={mockAccessState}
        billingApi={mockBillingApi}
        user={{ username: "stream_user", email: "user@example.com" }}
      />
    );

    expect(screen.getByRole("tab", { name: /Account/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /Billing/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /Connections/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /Support/i })).toBeDefined();

    // Close button triggers onClose
    const closeBtn = screen.getByRole("button", { name: /Close/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("switches tabs and displays billing content", async () => {
    render(
      <AccountSettingsModal
        isOpen={true}
        onClose={() => {}}
        accessState={mockAccessState}
        billingApi={mockBillingApi}
        user={{ username: "stream_user" }}
      />
    );

    const billingTab = screen.getByRole("tab", { name: /Billing/i });
    fireEvent.click(billingTab);

    expect(mockBillingApi.getConfig).toHaveBeenCalled();
  });
});
