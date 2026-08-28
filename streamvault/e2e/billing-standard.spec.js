import { test, expect } from "./fixtures/app.fixture.js";
import {
  mockAppBackend,
  mockLoggedOutUser,
  mockLoginSuccess,
  mockTurnstile,
} from "./fixtures/auth.fixture.js";

test.describe("Standard Billing & Support Journeys", () => {
  test("free user views Standard products and initiates checkout with policy agreement", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockLoginSuccess(appPage, {
      role: "free",
      plan: "free",
      billingStatus: "active",
      limits: { maxConnections: 2, maxLogins: 1 },
    });
    await mockTurnstile(appPage);
    await mockAppBackend(appPage);

    // Mock billing routes
    await appPage.route("**/api/billing/config", async (route) => {
      await route.fulfill({
        json: {
          enabled: true,
          currency: "usd",
          refundWindowDays: 7,
          products: [
            {
              code: "standard_pass_30d",
              name: "Standard 30-Day Pass",
              mode: "payment",
              currency: "usd",
              amount: 399,
              interval: null,
              display: { title: "Standard 30-Day Pass", priceFormatted: "$3.99" },
            },
            {
              code: "standard_monthly",
              name: "Standard (Monthly)",
              mode: "subscription",
              currency: "usd",
              amount: 299,
              interval: "month",
              display: { title: "Standard Monthly", priceFormatted: "$2.99 / month" },
            },
          ],
          currentPolicies: {
            terms: { version: "v1", publicUrl: "https://media.portalheaven.stream/legal/terms-v1.html" },
            privacy: { version: "v1", publicUrl: "https://media.portalheaven.stream/legal/privacy-v1.html" },
            refund: { version: "v1", publicUrl: "https://media.portalheaven.stream/legal/refund-v1.html" },
          },
        },
      });
    });

    await appPage.route("**/api/billing/orders", async (route) => {
      await route.fulfill({
        json: {
          orders: [
            {
              id: "ord_sample_1",
              product_code: "standard_pass_30d",
              amount: 399,
              currency: "usd",
              status: "paid",
              is_refund_eligible: 1,
              refunded_at: null,
              created_at: Date.now() - 3600 * 1000,
            },
          ],
        },
      });
    });

    await appPage.route("**/api/billing/history", async (route) => {
      await route.fulfill({
        json: {
          orders: [
            {
              id: "ord_sample_1",
              product_code: "standard_pass_30d",
              amount: 399,
              currency: "usd",
              status: "paid",
              is_refund_eligible: 1,
              refunded_at: null,
              created_at: Date.now() - 3600 * 1000,
            },
          ],
          subscription: null,
          entitlements: [],
        },
      });
    });

    let checkoutBody = null;
    await appPage.route("**/api/billing/checkout", async (route) => {
      checkoutBody = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        json: {
          checkoutUrl: "https://checkout.stripe.test/c/pay/cs_test_12345",
          orderId: "ord_mock_123",
        },
      });
    });

    await appPage.addInitScript(() => {
      localStorage.setItem("sv-disclaimer-accepted", "1");
    });

    // Navigate to app directly with ?settingsTab=billing
    await appPage.goto("/app?settingsTab=billing");
    await appPage.getByPlaceholder("Username").fill("free-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();

    // Verify modal is visible
    await expect(appPage.getByText("Account & Billing Settings")).toBeVisible();

    // Switch to Billing tab
    await appPage.getByRole("tab", { name: "Billing" }).click();

    await expect(appPage.getByText("Standard 30-Day Pass")).toBeVisible();
    await expect(appPage.getByText("$3.99")).toBeVisible();

    // Verify Pro and Friend & Family are NOT exposed as public choices
    await expect(appPage.getByText(/Friend & Family/i)).not.toBeVisible();

    // Agreement checkbox required before checkout
    const agreementCheckbox = appPage.locator("#billing-policy-agree");
    await agreementCheckbox.check({ force: true });

    // Click Buy 30-Day Pass button
    const buyButton = appPage.getByRole("button", { name: /Buy 30-Day Pass/i });
    await buyButton.click();

    // Verify checkout payload
    expect(checkoutBody).toMatchObject({
      productCode: "standard_pass_30d",
      acceptedPolicyVersions: {
        terms: "v1",
        privacy: "v1",
        refund: "v1",
      },
    });
  });

  test("user can request refund on eligible orders and submit support tickets", async ({ appPage }) => {
    await mockLoggedOutUser(appPage);
    await mockLoginSuccess(appPage, {
      role: "regular",
      plan: "standard",
      billingStatus: "active",
      limits: { maxConnections: 5, maxLogins: 1 },
    });
    await mockTurnstile(appPage);
    await mockAppBackend(appPage);

    await appPage.route("**/api/billing/config", async (route) => {
      await route.fulfill({
        json: {
          enabled: true,
          currency: "usd",
          refundWindowDays: 7,
          products: [],
          currentPolicies: {
            terms: { version: "v1" },
            privacy: { version: "v1" },
            refund: { version: "v1" },
          },
        },
      });
    });

    let refundRequested = false;
    await appPage.route("**/api/billing/refunds", async (route) => {
      refundRequested = true;
      await route.fulfill({
        json: {
          ok: true,
          status: "refund_pending",
        },
      });
    });

    await appPage.route("**/api/billing/orders", async (route) => {
      await route.fulfill({
        json: {
          orders: [
            {
              id: "ord_refundable_1",
              product_code: "standard_pass_30d",
              amount: 399,
              currency: "usd",
              status: "paid",
              is_refund_eligible: 1,
              refunded_at: null,
              created_at: Date.now() - 3600 * 1000,
            },
          ],
        },
      });
    });

    await appPage.route("**/api/billing/history", async (route) => {
      await route.fulfill({
        json: {
          orders: [
            {
              id: "ord_refundable_1",
              product_code: "standard_pass_30d",
              amount: 399,
              currency: "usd",
              status: "paid",
              is_refund_eligible: 1,
              refunded_at: null,
              created_at: Date.now() - 3600 * 1000,
            },
          ],
          subscription: null,
          entitlements: [],
        },
      });
    });

    await appPage.route("**/api/support/tickets", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 201,
          json: {
            ticketId: "tkt_e2e_1",
            status: "open",
            category: "billing_refund",
          },
        });
      } else {
        await route.fulfill({
          json: {
            tickets: [],
          },
        });
      }
    });

    await appPage.addInitScript(() => {
      localStorage.setItem("sv-disclaimer-accepted", "1");
    });

    await appPage.goto("/app?settingsTab=billing");
    await appPage.getByPlaceholder("Username").fill("regular-user");
    await appPage.getByPlaceholder("Password").fill("test-pass");
    await appPage.getByRole("button", { name: "Login" }).last().click();

    // Verify modal is visible and switch to Billing tab
    await expect(appPage.getByText("Account & Billing Settings")).toBeVisible();
    await appPage.getByRole("tab", { name: "Billing" }).click();

    // Click Request Refund button
    appPage.on("dialog", (dialog) => dialog.accept());
    const refundBtn = appPage.getByRole("button", { name: /Request Refund/i });
    await expect(refundBtn).toBeVisible();
    await refundBtn.click();

    expect(refundRequested).toBe(true);

    // Switch to Support Tab
    const supportTab = appPage.getByRole("tab", { name: "Support" });
    await supportTab.click();

    await expect(appPage.getByText("Contact Support")).toBeVisible();
    await appPage.locator("#support-message").fill("Hello, I need assistance with my billing refund.");
    await appPage.getByRole("button", { name: /Submit Support Ticket/i }).click();

    await expect(appPage.getByText(/created successfully/i)).toBeVisible();
  });
});
