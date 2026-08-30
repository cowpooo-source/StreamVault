import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("renders an accessible themed dialog shell", () => {
    render(
      <AccountSettingsModal
        isOpen={true}
        onClose={() => {}}
        accessState={mockAccessState}
        billingApi={mockBillingApi}
        user={{ username: "stream_user" }}
      />
    );

    expect(screen.getByRole("dialog", { name: "Account & Billing Settings" })).toHaveClass("account-settings-modal");
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

  it("opens on the requested initial tab", async () => {
    render(
      <AccountSettingsModal
        isOpen={true}
        initialTab="billing"
        onClose={() => {}}
        accessState={mockAccessState}
        billingApi={mockBillingApi}
        user={{ username: "stream_user" }}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Billing/i })).toHaveAttribute("aria-selected", "true");
    });
  });

  it("resets to the requested tab when reopened with a new initial tab", () => {
    const view = render(
      <AccountSettingsModal
        isOpen={true}
        initialTab="account"
        onClose={() => {}}
        accessState={mockAccessState}
        billingApi={mockBillingApi}
        user={{ username: "stream_user" }}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /Support/i }));
    view.rerender(
      <AccountSettingsModal
        isOpen={false}
        initialTab="billing"
        onClose={() => {}}
        accessState={mockAccessState}
        billingApi={mockBillingApi}
        user={{ username: "stream_user" }}
      />
    );
    view.rerender(
      <AccountSettingsModal
        isOpen={true}
        initialTab="billing"
        onClose={() => {}}
        accessState={mockAccessState}
        billingApi={mockBillingApi}
        user={{ username: "stream_user" }}
      />
    );

    expect(screen.getByRole("tab", { name: /Billing/i })).toHaveAttribute("aria-selected", "true");
  });

  it("opens Billing from the free-tier upgrade action", () => {
    render(
      <AccountSettingsModal
        isOpen={true}
        onClose={() => {}}
        accessState={{ role: "free", plan: "free", limits: { maxConnections: 2, maxLogins: 1 } }}
        billingApi={mockBillingApi}
        user={{ username: "stream_user" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /upgrade plan/i }));
    expect(screen.getByRole("tab", { name: /billing/i })).toHaveAttribute("aria-selected", "true");
  });
});
