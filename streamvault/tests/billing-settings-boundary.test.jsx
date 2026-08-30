import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import SettingsView from "../src/components/SettingsView.jsx";

vi.mock("../src/app-runtime.js", () => ({
  db: { get: vi.fn(async (_key, fallback) => fallback) },
}));

describe("Billing Settings Boundary (HTTP Content Mode vs HTTPS)", () => {
  const defaultProps = {
    connections: [{ id: "conn_1", label: "Primary Stream" }],
    authUser: { username: "alice", role: "free" },
    activeConnId: "conn_1",
    onAuth: vi.fn(),
    onImportFull: vi.fn(),
    autoLoadMore: false,
    setAutoLoadMore: vi.fn(),
    onThemeChange: vi.fn(),
    onLanguageChange: vi.fn(),
  };

  it("enforces HTTP content player-only boundary: renders Player Settings, no Account tab, no support form, and delegates to secure HTTPS", () => {
    const openSecure = vi.fn();
    render(
      <SettingsView
        {...defaultProps}
        contentMode={true}
        onOpenSecureSettings={openSecure}
      />
    );

    // Header says Player Settings
    expect(screen.getByText("Player Settings")).toBeInTheDocument();

    // Account tab is not present in tabs list
    expect(screen.queryByRole("tab", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Billing" })).not.toBeInTheDocument();
    expect(screen.queryByText("Send Support Request")).not.toBeInTheDocument();

    // Prominent Account, Billing & Support button delegates to secure HTTPS
    const secureBtn = screen.getByRole("button", { name: /account, billing & support/i });
    expect(secureBtn).toBeInTheDocument();
    fireEvent.click(secureBtn);
    expect(openSecure).toHaveBeenCalledWith("billing");
  });

  it("renders full settings with Account tab on HTTPS control plane", () => {
    const onOpenAccount = vi.fn();
    render(
      <SettingsView
        {...defaultProps}
        contentMode={false}
        onOpenAccountSettings={onOpenAccount}
      />
    );

    // Player Settings heading is not shown on HTTPS control plane
    expect(screen.queryByText("Player Settings")).not.toBeInTheDocument();

    // Account tab is available
    const accountTab = screen.getByRole("tab", { name: "Account" });
    expect(accountTab).toBeInTheDocument();

    fireEvent.click(accountTab);
    expect(screen.getByText("Account Plan & Subscriptions")).toBeInTheDocument();
    expect(screen.getByText("Profile")).toBeInTheDocument();

    // Clicking Billing & Plans triggers account settings modal
    const billingBtn = screen.getByRole("button", { name: /billing & plans/i });
    fireEvent.click(billingBtn);
    expect(onOpenAccount).toHaveBeenCalledWith("billing");
  });

  it("delegates billing access to the secure settings handler when the modal handler is unavailable", () => {
    const openSecure = vi.fn();
    render(
      <SettingsView
        {...defaultProps}
        contentMode={false}
        onOpenSecureSettings={openSecure}
      />
    );

    fireEvent.click(screen.getByText("Account"));
    fireEvent.click(screen.getByRole("button", { name: /billing & plans/i }));

    expect(openSecure).toHaveBeenCalledWith("billing");
  });
});
