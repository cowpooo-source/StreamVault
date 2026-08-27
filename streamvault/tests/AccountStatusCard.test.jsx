import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AccountStatusCard from "../src/components/AccountStatusCard.jsx";

describe("AccountStatusCard Component", () => {
  it("renders Free tier with upgrade action", () => {
    const onOpenUpgrade = vi.fn();
    const accessState = {
      role: "free",
      plan: "free",
      billingStatus: "none",
      limits: { maxConnections: 2, maxLogins: 1 },
    };

    render(<AccountStatusCard accessState={accessState} onOpenUpgrade={onOpenUpgrade} />);

    expect(screen.getByRole("heading", { name: /Free Plan/i })).toBeDefined();
    expect(screen.getByText(/2 Connections/i)).toBeDefined();
    const upgradeBtn = screen.getByRole("button", { name: /Upgrade/i });
    fireEvent.click(upgradeBtn);
    expect(onOpenUpgrade).toHaveBeenCalled();
  });

  it("renders Regular tier with active subscription and manage button", () => {
    const onManageBilling = vi.fn();
    const accessState = {
      role: "regular",
      plan: "standard",
      planSource: "paid",
      billingStatus: "active",
      limits: { maxConnections: 5, maxLogins: 3 },
      accessEndsAt: 1_700_000_000_000,
    };

    render(<AccountStatusCard accessState={accessState} onManageBilling={onManageBilling} />);

    expect(screen.getByRole("heading", { name: /Standard Plan/i })).toBeDefined();
    expect(screen.getByText(/5 Connections/i)).toBeDefined();
    const manageBtn = screen.getByRole("button", { name: /Manage Billing/i });
    fireEvent.click(manageBtn);
    expect(onManageBilling).toHaveBeenCalled();
  });
});
