import { describe, it, expect } from "vitest";
import { createBillingCatalog, billingConfigStatus } from "../../src/services/billingCatalog.js";

describe("billingCatalog", () => {
  const validEnabledEnv = {
    BILLING_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_123",
    STRIPE_PRICE_STANDARD_PASS_30D: "price_pass_30d_123",
    STRIPE_PRICE_STANDARD_MONTHLY: "price_monthly_123",
    STRIPE_PRICE_STANDARD_YEARLY: "price_yearly_123",
    STRIPE_LIVE_MODE: "false",
    STRIPE_TAX_ENABLED: "true",
    APP_URL: "https://media.portalheaven.stream/app",
    SUPPORT_EMAIL: "support@portalheaven.stream",
  };

  describe("disabled mode", () => {
    it("returns disabled catalog when BILLING_ENABLED is false or unset", () => {
      const catalog = createBillingCatalog({ BILLING_ENABLED: "false" });
      expect(catalog.enabled).toBe(false);
      expect(catalog.products).toEqual([]);
      expect(() => catalog.getProduct("standard_monthly")).toThrow(/billing_product_invalid|billing_disabled/);
    });

    it("returns disabled catalog for empty env without throwing", () => {
      const catalog = createBillingCatalog({});
      expect(catalog.enabled).toBe(false);
    });
  });

  describe("enabled mode with fixed products", () => {
    it("returns configured products with correct prices and intervals", () => {
      const catalog = createBillingCatalog(validEnabledEnv);
      expect(catalog.enabled).toBe(true);
      expect(catalog.livemode).toBe(false);
      expect(catalog.taxEnabled).toBe(true);

      const pass = catalog.getProduct("standard_pass_30d");
      expect(pass).toMatchObject({
        code: "standard_pass_30d",
        mode: "payment",
        currency: "usd",
        amount: 399,
        interval: null,
        priceId: "price_pass_30d_123",
      });

      const monthly = catalog.getProduct("standard_monthly");
      expect(monthly).toMatchObject({
        code: "standard_monthly",
        mode: "subscription",
        currency: "usd",
        amount: 299,
        interval: "month",
        priceId: "price_monthly_123",
      });

      const yearly = catalog.getProduct("standard_yearly");
      expect(yearly).toMatchObject({
        code: "standard_yearly",
        mode: "subscription",
        currency: "usd",
        amount: 2999,
        interval: "year",
        priceId: "price_yearly_123",
      });
    });

    it("rejects unknown or browser-supplied product codes", () => {
      const catalog = createBillingCatalog(validEnabledEnv);
      expect(() => catalog.getProduct("price_from_browser")).toThrow(/billing_product_invalid/);
      try {
        catalog.getProduct("price_from_browser");
      } catch (err) {
        expect(err.code).toBe("billing_product_invalid");
        expect(err.status).toBe(400);
      }
    });

    it("provides versioned policy metadata", () => {
      const catalog = createBillingCatalog(validEnabledEnv);
      const policies = catalog.currentPolicies();
      expect(policies).toMatchObject({
        terms: {
          version: "v1",
          publicUrl: "https://media.portalheaven.stream/legal/terms-v1.html",
        },
        privacy: {
          version: "v1",
          publicUrl: "https://media.portalheaven.stream/legal/privacy-v1.html",
        },
        refund: {
          version: "v1",
          publicUrl: "https://media.portalheaven.stream/legal/refund-v1.html",
        },
      });
    });

    it("lists public product metadata safely", () => {
      const catalog = createBillingCatalog(validEnabledEnv);
      const publicList = catalog.listPublicProducts();
      expect(publicList).toHaveLength(3);
      expect(publicList.map((p) => p.code)).toEqual([
        "standard_pass_30d",
        "standard_monthly",
        "standard_yearly",
      ]);
      for (const p of publicList) {
        expect(p).toHaveProperty("code");
        expect(p).toHaveProperty("amount");
        expect(p).toHaveProperty("currency", "usd");
        expect(p).toHaveProperty("display");
      }
    });
  });

  describe("validation of required configuration when enabled", () => {
    const requiredKeys = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_STANDARD_PASS_30D",
      "STRIPE_PRICE_STANDARD_MONTHLY",
      "STRIPE_PRICE_STANDARD_YEARLY",
    ];

    for (const key of requiredKeys) {
      it(`throws when ${key} is missing or empty`, () => {
        const env = { ...validEnabledEnv, [key]: "" };
        expect(() => createBillingCatalog(env)).toThrow(new RegExp(key));
      });
    }
  });

  describe("billingConfigStatus", () => {
    it("reports safe status without printing secrets", () => {
      const status = billingConfigStatus(validEnabledEnv);
      expect(status).toMatchObject({
        enabled: true,
        configured: true,
        livemode: false,
        taxEnabled: true,
      });
      const str = JSON.stringify(status);
      expect(str).not.toContain("sk_test_123");
      expect(str).not.toContain("whsec_123");
    });

    it("reports disabled status when disabled", () => {
      const status = billingConfigStatus({ BILLING_ENABLED: "false" });
      expect(status).toMatchObject({
        enabled: false,
        configured: false,
      });
    });
  });
});
