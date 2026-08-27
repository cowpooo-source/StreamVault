import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import auth from "../../src/auth.js";
import { createBillingCatalog } from "../../src/services/billingCatalog.js";
import { createBillingStore } from "../../src/services/billingStore.js";
import { createEntitlementService } from "../../src/services/entitlementService.js";
import { createBillingRouter } from "../../src/routes/billing.js";

describe("Billing Lifecycle Router", () => {
  let app;
  let db;
  let store;
  let catalog;
  let entitlementService;
  let mockStripeGateway;
  let userToken;
  let testUser;
  let fixedNow = 1_700_000_000_000;
  const DAY_MS = 86400000;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");

    process.env.ADMIN_PASS = "admin123";
    process.env.ADMIN_USER = "admin";
    process.env.JWT_SECRET = "test-secret-key";
    process.env.DEFAULT_ROLE = "free";
    process.env.CONNECTION_IDENTITY_HMAC_KEY = "test-hmac-secret-12345678901234567890";

    await auth.init(db);

    store = auth.getBillingStore();
    entitlementService = auth.getEntitlementService();

    catalog = createBillingCatalog({
      BILLING_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_STANDARD_PASS_30D: "price_pass_30d",
      STRIPE_PRICE_STANDARD_MONTHLY: "price_monthly",
      STRIPE_PRICE_STANDARD_YEARLY: "price_yearly",
      STRIPE_LIVE_MODE: "false",
      STRIPE_TAX_ENABLED: "true",
      POLICY_TERMS_VERSION: "v1",
      POLICY_TERMS_URL: "https://media.portalheaven.stream/legal/terms-v1.html",
      POLICY_PRIVACY_VERSION: "v1",
      POLICY_PRIVACY_URL: "https://media.portalheaven.stream/legal/privacy-v1.html",
      POLICY_REFUND_VERSION: "v1",
      POLICY_REFUND_URL: "https://media.portalheaven.stream/legal/refund-v1.html",
      APP_URL: "https://media.portalheaven.stream/app",
      SUPPORT_EMAIL: "support@portalheaven.stream",
    });

    mockStripeGateway = {
      createCheckout: vi.fn().mockResolvedValue({
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
        sessionId: "cs_test_123",
        mode: "payment",
      }),
      createSetupCheckout: vi.fn().mockResolvedValue({
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_setup_123",
        sessionId: "cs_setup_123",
        mode: "setup",
      }),
      createPortalSession: vi.fn().mockResolvedValue({
        portalUrl: "https://billing.stripe.com/p/session/portal_123",
      }),
      cancelSubscription: vi.fn().mockResolvedValue({
        id: "sub_123",
        cancel_at_period_end: true,
      }),
      createRefund: vi.fn().mockResolvedValue({
        id: "re_123",
        status: "succeeded",
      }),
    };

    testUser = await auth.createUser("bill_user", "pass1234", "free");
    const session = await auth.authenticate(testUser.username, "pass1234");
    userToken = session.token;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(
      "/api/billing",
      createBillingRouter({
        auth,
        catalog,
        store,
        entitlementService,
        stripeGateway: mockStripeGateway,
        now: () => fixedNow,
      })
    );
  });

  afterEach(() => {
    db?.close();
  });

  describe("GET /api/billing/config", () => {
    it("returns public billing config, products, and versioned policies", async () => {
      const res = await request(app).get("/api/billing/config");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: true,
        testMode: true,
        currency: "usd",
        policies: {
          terms: { version: "v1" },
          privacy: { version: "v1" },
          refund: { version: "v1" },
        },
        supportEmail: "support@portalheaven.stream",
      });
      expect(res.body.products.length).toBeGreaterThan(0);
    });

    it("returns disabled config when billing is disabled", async () => {
      const disabledCatalog = createBillingCatalog({ BILLING_ENABLED: "false" });
      const disabledApp = express();
      disabledApp.use(
        "/api/billing",
        createBillingRouter({
          auth,
          catalog: disabledCatalog,
          store,
          entitlementService,
          stripeGateway: null,
        })
      );

      const res = await request(disabledApp).get("/api/billing/config");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: false,
        products: [],
        policies: null,
      });
    });
  });

  describe("POST /api/billing/checkout", () => {
    it("requires authentication", async () => {
      const res = await request(app)
        .post("/api/billing/checkout")
        .send({ productCode: "standard_pass_30d" });
      expect(res.status).toBe(401);
    });

    it("validates required policy agreement versions", async () => {
      const res = await request(app)
        .post("/api/billing/checkout")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          productCode: "standard_pass_30d",
          acceptedPolicies: {
            termsVersion: "v0_outdated",
            privacyVersion: "v1",
            refundVersion: "v1",
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_agreement");
    });

    it("creates payment checkout for 30-Day Pass and stores order + agreement", async () => {
      const res = await request(app)
        .post("/api/billing/checkout")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          productCode: "standard_pass_30d",
          acceptedPolicies: {
            termsVersion: "v1",
            privacyVersion: "v1",
            refundVersion: "v1",
          },
          returnUrl: "https://media.portalheaven.stream/app/billing",
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
        mode: "payment",
      });

      const order = store.getOrder(res.body.orderId);
      expect(order).toBeDefined();
      expect(order.user_id).toBe(testUser.id);
      expect(order.product_code).toBe("standard_pass_30d");

      const agreement = store.getAgreementByOrderId(res.body.orderId);
      expect(agreement).toBeDefined();
      expect(agreement.terms_version).toBe("v1");
    });

    it("returns 503 when billing is disabled", async () => {
      const disabledCatalog = createBillingCatalog({ BILLING_ENABLED: "false" });
      const disabledApp = express();
      disabledApp.use(express.json());
      disabledApp.use(
        "/api/billing",
        createBillingRouter({
          auth,
          catalog: disabledCatalog,
          store,
          entitlementService,
          stripeGateway: null,
        })
      );

      const res = await request(disabledApp)
        .post("/api/billing/checkout")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ productCode: "standard_pass_30d" });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("billing_disabled");
    });
  });

  describe("POST /api/billing/portal", () => {
    it("creates a customer portal session for an existing customer", async () => {
      store.upsertCustomer({ userId: testUser.id, stripeCustomerId: "cus_test_123" });

      const res = await request(app)
        .post("/api/billing/portal")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ returnUrl: "https://media.portalheaven.stream/app/settings" });

      expect(res.status).toBe(200);
      expect(res.body.portalUrl).toBe("https://billing.stripe.com/p/session/portal_123");
    });

    it("returns 400 if user has no stripe customer mapping", async () => {
      const res = await request(app)
        .post("/api/billing/portal")
        .set("Authorization", `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("no_billing_customer");
    });
  });

  describe("POST /api/billing/cancel", () => {
    it("schedules subscription cancellation at period end", async () => {
      store.upsertSubscription({
        userId: testUser.id,
        stripeSubscriptionId: "sub_cancel_test",
        status: "active",
      });

      const res = await request(app)
        .post("/api/billing/cancel")
        .set("Authorization", `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.cancelAtPeriodEnd).toBe(true);

      const sub = store.getSubscriptionByStripeId("sub_cancel_test");
      expect(sub.cancel_at_period_end).toBe(1);
    });
  });

  describe("POST /api/billing/refund", () => {
    it("processes automated refund within 72-hour window and revokes entitlement", async () => {
      const order = store.createOrder({
        id: "ord_refund_test",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        amount: 399,
        status: "paid",
        stripePaymentIntentId: "pi_ref_123",
        createdAt: fixedNow - 10 * 3600 * 1000, // 10 hours ago (< 72h)
        refundableUntil: fixedNow + 62 * 3600 * 1000,
      });

      entitlementService.activatePass({
        userId: testUser.id,
        orderId: "ord_refund_test",
        startsAt: fixedNow - 10 * 3600 * 1000,
        endsAt: fixedNow + 20 * DAY_MS,
      });

      expect(entitlementService.getEffectiveAccess(testUser.id, fixedNow).role).toBe("regular");

      const res = await request(app)
        .post("/api/billing/refund")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ orderId: "ord_refund_test", reason: "requested_by_customer" });

      expect(res.status).toBe(200);
      expect(res.body.refunded).toBe(true);

      const updatedOrder = store.getOrder("ord_refund_test");
      expect(updatedOrder.status).toBe("refunded");
      expect(entitlementService.getEffectiveAccess(testUser.id, fixedNow).role).toBe("free");
    });

    it("rejects refund if outside 72-hour window", async () => {
      store.createOrder({
        id: "ord_expired_refund",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        amount: 399,
        status: "paid",
        stripePaymentIntentId: "pi_old_123",
        createdAt: fixedNow - 80 * 3600 * 1000, // 80 hours ago (> 72h)
        refundableUntil: fixedNow - 8 * 3600 * 1000,
      });

      const res = await request(app)
        .post("/api/billing/refund")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ orderId: "ord_expired_refund" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("refund_window_expired");
    });
  });

  describe("GET /api/billing/history", () => {
    it("returns orders, activePass, subscription, and entitlements for user", async () => {
      store.createOrder({
        id: "ord_hist_1",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        amount: 399,
        status: "paid",
      });

      const res = await request(app)
        .get("/api/billing/history")
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.orders.length).toBe(1);
      expect(res.body.orders[0].id).toBe("ord_hist_1");
    });
  });
});