import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BillingSettings from "../src/components/BillingSettings.jsx";

describe("BillingSettings Component", () => {
  let mockBillingApi;

  beforeEach(() => {
    window.confirm = vi.fn().mockReturnValue(true);
    mockBillingApi = {
      getConfig: vi.fn().mockResolvedValue({
        enabled: true,
        products: [
          {
            code: "standard_pass_30d",
            name: "Standard 30-Day Pass",
            display: { title: "Standard 30-Day Pass", priceFormatted: "$2.99" },
          },
          {
            code: "standard_monthly",
            name: "Standard Monthly",
            display: { title: "Standard Monthly", priceFormatted: "$2.85/mo" },
          },
        ],
        policies: {
          terms: { version: "v1", publicUrl: "https://media.portalheaven.stream/legal/terms-v1.html" },
          privacy: { version: "v1", publicUrl: "https://media.portalheaven.stream/legal/privacy-v1.html" },
          refund: { version: "v1", publicUrl: "https://media.portalheaven.stream/legal/refund-v1.html" },
        },
      }),
      listOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            id: "ord_1",
            product_code: "standard_pass_30d",
            amount_total: 299,
            status: "paid",
            checkout_mode: "payment",
            refundable_until: Date.now() + 100000,
            created_at: Date.now() - 10000,
          },
        ],
      }),
      startCheckout: vi.fn().mockResolvedValue({ checkoutUrl: "https://checkout.stripe.com/test" }),
      openCustomerPortal: vi.fn().mockResolvedValue({ portalUrl: "https://billing.stripe.com/test" }),
      requestRefund: vi.fn().mockResolvedValue({ status: "refund_pending" }),
      cancelSubscription: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  it("renders product catalog and requires agreement checkbox before checkout", async () => {
    const accessState = { role: "free", plan: "free" };
    render(<BillingSettings billingApi={mockBillingApi} accessState={accessState} onRefresh={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Standard 30-Day Pass/i)).toBeDefined();
    });

    // Verify policy link hrefs use publicUrl contract
    const termsLink = screen.getByRole("link", { name: /Terms of Service/i });
    expect(termsLink.getAttribute("href")).toBe("https://media.portalheaven.stream/legal/terms-v1.html");

    const privacyLink = screen.getByRole("link", { name: /Privacy Policy/i });
    expect(privacyLink.getAttribute("href")).toBe("https://media.portalheaven.stream/legal/privacy-v1.html");

    const refundLink = screen.getByRole("link", { name: /Refund Policy/i });
    expect(refundLink.getAttribute("href")).toBe("https://media.portalheaven.stream/legal/refund-v1.html");

    const checkoutBtn = screen.getByRole("button", { name: /Buy 30-Day Pass/i });
    expect(checkoutBtn.disabled).toBe(true);

    const agreementCheckbox = screen.getByRole("checkbox", { name: /I agree/i });
    fireEvent.click(agreementCheckbox);

    expect(checkoutBtn.disabled).toBe(false);
    fireEvent.click(checkoutBtn);

    await waitFor(() => {
      expect(mockBillingApi.startCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          productCode: "standard_pass_30d",
          acceptedPolicyVersions: { terms: "v1", privacy: "v1", refund: "v1" },
        })
      );
    });
  });

  it("allows requesting automated refund on eligible orders", async () => {
    const accessState = { role: "regular", plan: "standard" };
    render(<BillingSettings billingApi={mockBillingApi} accessState={accessState} onRefresh={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/ord_1/i)).toBeDefined();
    });

    const refundBtn = screen.getByRole("button", { name: /Request Refund/i });
    fireEvent.click(refundBtn);

    await waitFor(() => {
      expect(mockBillingApi.requestRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "ord_1",
        })
      );
    });
  });
});
