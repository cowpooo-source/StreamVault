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
        url: "https://billing.stripe.com/p/session/portal_123",
      }),
      cancelAtPeriodEnd: vi.fn().mockResolvedValue({
        id: "sub_123",
        cancel_at_period_end: true,
      }),
      cancelSchedule: vi.fn().mockResolvedValue({
        id: "sub_sched_123",
        status: "canceled",
      }),
      createFullRefund: vi.fn().mockResolvedValue({
        id: "re_123",
        status: "succeeded",
      }),
      retrieveForReconciliation: vi.fn().mockImplementation(async ({ paymentIntentId }) => {
        return {
          paymentIntent: {
            id: paymentIntentId,
            status: "succeeded",
            amount: 399,
            amount_refunded: 0,
          },
        };
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

    it("validates required policy agreement versions with acceptedPolicyVersions format", async () => {
      const res = await request(app)
        .post("/api/billing/checkout")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          productCode: "standard_pass_30d",
          acceptedPolicyVersions: {
            terms: "v0_outdated",
            privacy: "v1",
            refund: "v1",
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_agreement");
    });

    it("creates payment checkout for 30-Day Pass, sanitizes external returnUrl, and stores real policy content hashes", async () => {
      const res = await request(app)
        .post("/api/billing/checkout")
        .set("Authorization", `Bearer ${userToken}`)
        .send({
          productCode: "standard_pass_30d",
          acceptedPolicyVersions: {
            terms: "v1",
            privacy: "v1",
            refund: "v1",
          },
          returnUrl: "https://evil-external-domain.com/phishing",
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
        mode: "payment",
      });

      // External returnUrl must be sanitized to safe default path
      expect(mockStripeGateway.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          returnPath: "/app?settingsTab=billing",
          order: expect.objectContaining({
            id: res.body.orderId,
            productCode: "standard_pass_30d",
          }),
        })
      );

      const order = store.getOrder(res.body.orderId);
      expect(order).toBeDefined();
      expect(order.user_id).toBe(testUser.id);
      expect(order.product_code).toBe("standard_pass_30d");

      const agreement = store.getAgreementByOrderId(res.body.orderId);
      expect(agreement).toBeDefined();
      expect(agreement.terms_version).toBe("v1");

      const expectedContentHash = catalog.getPolicyContentSha256("terms", "v1");
      expect(agreement.terms_sha256).toBe(expectedContentHash);
    });

    it("enforces CSRF and Origin checks on cookie-authenticated requests", async () => {
      const cookieApp = express();
      cookieApp.use(express.json());
      cookieApp.use(cookieParser());
      cookieApp.use(
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

      // Request with Cookie auth (sv_auth) but cross-origin Origin header
      const res = await request(cookieApp)
        .post("/api/billing/checkout")
        .set("Cookie", `sv_auth=${userToken}`)
        .set("Origin", "https://malicious-attacker.com")
        .set("Host", "media.portalheaven.stream")
        .send({
          productCode: "standard_pass_30d",
          acceptedPolicyVersions: { terms: "v1", privacy: "v1", refund: "v1" },
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("csrf_rejected");
    });
  });

  describe("POST /api/billing/portal", () => {
    it("creates a customer portal session using gateway createPortalSession", async () => {
      store.upsertCustomer({ userId: testUser.id, stripeCustomerId: "cus_test_123" });

      const res = await request(app)
        .post("/api/billing/portal")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ returnUrl: "/app?settingsTab=billing" });

      expect(res.status).toBe(200);
      expect(res.body.portalUrl).toBe("https://billing.stripe.com/p/session/portal_123");
      expect(mockStripeGateway.createPortalSession).toHaveBeenCalledWith({
        customerId: "cus_test_123",
        returnUrl: "https://media.portalheaven.stream/app?settingsTab=billing",
      });
    });
  });

  describe("POST /api/billing/subscription/cancel", () => {
    it("schedules subscription cancellation at period end via gateway cancelAtPeriodEnd", async () => {
      store.upsertSubscription({
        userId: testUser.id,
        stripeSubscriptionId: "sub_cancel_test",
        status: "active",
      });

      const res = await request(app)
        .post("/api/billing/subscription/cancel")
        .set("Authorization", `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.cancelAtPeriodEnd).toBe(true);

      expect(mockStripeGateway.cancelAtPeriodEnd).toHaveBeenCalledWith({
        subscriptionId: "sub_cancel_test",
      });

      const sub = store.getSubscriptionByStripeId("sub_cancel_test");
      expect(sub.cancel_at_period_end).toBe(1);
    });
  });

  describe("POST /api/billing/subscription/scheduled/cancel", () => {
    it("cancels future subscription schedule via gateway cancelSchedule", async () => {
      store.upsertSubscription({
        userId: testUser.id,
        stripeSubscriptionId: "sub_with_sched",
        stripeScheduleId: "sub_sched_test_1",
        status: "active",
      });

      const res = await request(app)
        .post("/api/billing/subscription/scheduled/cancel")
        .set("Authorization", `Bearer ${userToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.canceled).toBe(true);
      expect(mockStripeGateway.cancelSchedule).toHaveBeenCalledWith({
        scheduleId: "sub_sched_test_1",
      });
    });
  });

  describe("POST /api/billing/refunds", () => {
    it("marks order refund_pending with refunded_at remaining null before webhook confirmation", async () => {
      const order = store.createOrder({
        id: "ord_refund_test",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        checkoutMode: "payment",
        amount: 399,
        status: "paid",
        stripePaymentIntentId: "pi_ref_123",
        createdAt: fixedNow - 10 * 3600 * 1000,
        refundableUntil: fixedNow + 62 * 3600 * 1000,
      });

      entitlementService.activatePass({
        userId: testUser.id,
        orderId: "ord_refund_test",
        startsAt: fixedNow - 10 * 3600 * 1000,
        endsAt: fixedNow + 20 * DAY_MS,
      });

      const res = await request(app)
        .post("/api/billing/refunds")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ orderId: "ord_refund_test", reason: "requested_by_customer" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("refund_pending");

      expect(mockStripeGateway.createFullRefund).toHaveBeenCalledWith({
        paymentIntentId: "pi_ref_123",
        orderId: "ord_refund_test",
      });

      const updatedOrder = store.getOrder("ord_refund_test");
      expect(updatedOrder.status).toBe("refund_pending");
      // refunded_at must remain NULL while in pending status
      expect(updatedOrder.refunded_at).toBeNull();

      // User retains access until charge.refunded webhook is received
      expect(entitlementService.getEffectiveAccess(testUser.id, fixedNow).role).toBe("regular");
    });

    it("allows refund within 7-calendar-day window and rejects after 7 calendar days", async () => {
      // 5 days ago (< 7 days) -> Allowed
      store.createOrder({
        id: "ord_day_5",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        checkoutMode: "payment",
        amountTotal: 399,
        status: "paid",
        stripePaymentIntentId: "pi_day_5",
        createdAt: fixedNow - 5 * DAY_MS,
        refundableUntil: fixedNow + 2 * DAY_MS,
      });

      const resValid = await request(app)
        .post("/api/billing/refunds")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ orderId: "ord_day_5" });

      expect(resValid.status).toBe(200);
      expect(resValid.body.status).toBe("refund_pending");

      // 8 days ago (> 7 days) -> Rejected
      store.createOrder({
        id: "ord_day_8",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        checkoutMode: "payment",
        amountTotal: 399,
        status: "paid",
        stripePaymentIntentId: "pi_day_8",
        createdAt: fixedNow - 8 * DAY_MS,
        refundableUntil: fixedNow - 1 * DAY_MS,
      });

      const resExpired = await request(app)
        .post("/api/billing/refunds")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ orderId: "ord_day_8" });

      expect(resExpired.status).toBe(400);
      expect(resExpired.body.code).toBe("refund_window_expired");
    });

    it("rejects refund if payment was already partially refunded in Stripe", async () => {
      store.createOrder({
        id: "ord_partial_pi",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        checkoutMode: "payment",
        amountTotal: 399,
        status: "paid",
        stripePaymentIntentId: "pi_partially_refunded",
        createdAt: fixedNow - 1 * DAY_MS,
        refundableUntil: fixedNow + 6 * DAY_MS,
      });

      mockStripeGateway.retrieveForReconciliation = vi.fn().mockResolvedValue({
        paymentIntent: {
          id: "pi_partially_refunded",
          status: "succeeded",
          amount: 399,
          amount_refunded: 100, // Partial refund exists!
        },
      });

      const res = await request(app)
        .post("/api/billing/refunds")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ orderId: "ord_partial_pi" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("already_refunded");
    });

    it("fails closed with 502 if Stripe payment verification is unavailable or errors", async () => {
      store.createOrder({
        id: "ord_stripe_error",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        checkoutMode: "payment",
        amountTotal: 399,
        status: "paid",
        stripePaymentIntentId: "pi_unreachable",
        createdAt: fixedNow - 1 * DAY_MS,
        refundableUntil: fixedNow + 6 * DAY_MS,
      });

      mockStripeGateway.retrieveForReconciliation = vi.fn().mockResolvedValue({
        paymentIntentError: "Connection timeout to Stripe API",
      });

      const res = await request(app)
        .post("/api/billing/refunds")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ orderId: "ord_stripe_error" });

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("stripe_verification_failed");

      // Verify createFullRefund was NOT called
      expect(mockStripeGateway.createFullRefund).not.toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "ord_stripe_error" })
      );
    });
  });

  describe("GET /api/billing/orders and /api/billing/history", () => {
    it("returns orders via /api/billing/orders", async () => {
      store.createOrder({
        id: "ord_list_1",
        userId: testUser.id,
        productCode: "standard_pass_30d",
        amount: 399,
        status: "paid",
      });

      const res = await request(app)
        .get("/api/billing/orders")
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body.orders.length).toBe(1);
      expect(res.body.orders[0].id).toBe("ord_list_1");
    });

    it("returns complete history overview via /api/billing/history", async () => {
      const res = await request(app)
        .get("/api/billing/history")
        .set("Authorization", `Bearer ${userToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("orders");
      expect(res.body).toHaveProperty("subscription");
      expect(res.body).toHaveProperty("entitlements");
    });
  });
});