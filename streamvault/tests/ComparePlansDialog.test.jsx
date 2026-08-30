import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ComparePlansDialog from "../src/components/ComparePlansDialog.jsx";

describe("ComparePlansDialog Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an accessible dialog with role='dialog', aria-modal='true', and accessible title", () => {
    render(<ComparePlansDialog isOpen={true} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: /compare plans/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: /compare plans/i })).toBeInTheDocument();
  });

  it("does not render when isOpen is false", () => {
    render(<ComparePlansDialog isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders all 4 data-driven tiers with exact specifications", () => {
    render(<ComparePlansDialog isOpen={true} onClose={vi.fn()} currentPlan="free" />);

    // 1. Guest Tier
    expect(screen.getByRole("heading", { name: /^Guest$/i })).toBeInTheDocument();
    expect(screen.getAllByText(/no account/i).length).toBeGreaterThan(0);

    // 2. Free Tier
    expect(screen.getByRole("heading", { name: /^Free$/i })).toBeInTheDocument();
    expect(screen.getAllByText(/free account/i).length).toBeGreaterThan(0);

    // Catalog & Watch time specs for Guest & Free
    const catalogTexts = screen.getAllByText(/5,000/i);
    expect(catalogTexts.length).toBeGreaterThanOrEqual(2);
    const watchTimeTexts = screen.getAllByText(/3 hours\/day/i);
    expect(watchTimeTexts.length).toBeGreaterThanOrEqual(2);

    // 3. Standard Tier
    expect(screen.getByRole("heading", { name: /^Standard$/i })).toBeInTheDocument();
    expect(screen.getByText(/\$2\.99 30-day pass/i)).toBeInTheDocument();
    expect(screen.getByText(/\$2\.85 monthly/i)).toBeInTheDocument();
    expect(screen.getByText(/\$29\.99 yearly/i)).toBeInTheDocument();
    expect(screen.getByText(/5 connections/i)).toBeInTheDocument();
    expect(screen.getByText(/3 sessions/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /standard plan/i })).toHaveTextContent(/billing\/support/i);

    // 4. Pro Tier
    expect(screen.getByRole("heading", { name: /^Pro$/i })).toBeInTheDocument();
    const comingSoonBadges = screen.getAllByText(/coming soon/i);
    expect(comingSoonBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/10 connections/i)).toBeInTheDocument();
    expect(screen.getByText(/5 sessions/i)).toBeInTheDocument();

    // Pro CTA is disabled and has no checkout action
    const proButton = screen.getByRole("button", { name: /coming soon/i });
    expect(proButton).toBeDisabled();

    // Display-only notice in footer
    expect(screen.getByText(/display-only.*not enforced/i)).toBeInTheDocument();
  });

  it("handles keyboard Escape to close dialog", () => {
    const onClose = vi.fn();
    render(<ComparePlansDialog isOpen={true} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("handles overlay backdrop click to close dialog", () => {
    const onClose = vi.fn();
    render(<ComparePlansDialog isOpen={true} onClose={onClose} />);

    const overlay = screen.getByTestId("compare-plans-overlay");
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it("handles close button click", () => {
    const onClose = vi.fn();
    render(<ComparePlansDialog isOpen={true} onClose={onClose} />);

    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("restores focus to previous active element on close", () => {
    const button = document.createElement("button");
    button.textContent = "Open Modal";
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    const { rerender } = render(<ComparePlansDialog isOpen={true} onClose={vi.fn()} />);
    rerender(<ComparePlansDialog isOpen={false} onClose={vi.fn()} />);

    expect(document.activeElement).toBe(button);
    document.body.removeChild(button);
  });

  it("wires Standard CTA in secure /app mode to onSelectPlan callback", () => {
    const onSelectPlan = vi.fn();
    render(
      <ComparePlansDialog
        isOpen={true}
        onClose={vi.fn()}
        currentPlan="free"
        onSelectPlan={onSelectPlan}
      />
    );

    const upgradeBtn = screen.getByRole("button", { name: /upgrade to standard|select standard/i });
    fireEvent.click(upgradeBtn);
    expect(onSelectPlan).toHaveBeenCalledWith("standard");
  });

  it("supports read-only HTTP /content mode: navigates to HTTPS /app on CTA click without billing APIs", () => {
    const onOpenSecure = vi.fn();
    render(
      <ComparePlansDialog
        isOpen={true}
        onClose={vi.fn()}
        contentMode={true}
        onOpenSecure={onOpenSecure}
      />
    );

    // Standard CTA indicates secure app navigation
    const secureUpgradeBtn = screen.getByRole("button", { name: /upgrade on secure app|upgrade to standard/i });
    fireEvent.click(secureUpgradeBtn);
    expect(onOpenSecure).toHaveBeenCalledWith("billing");
  });
});
