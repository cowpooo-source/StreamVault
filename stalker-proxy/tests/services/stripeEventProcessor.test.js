import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createBillingStore } from "../../src/services/billingStore.js";
import { createEntitlementService } from "../../src/services/entitlementService.js";
import { createBillingCatalog } from "../../src/services/billingCatalog.js";
import { createStripeEventProcessor } from "../../src/services/stripeEventProcessor.js";

describe("stripeEventProcessor", () => {
  let db;
  let store;
  let entitlementService;
  let catalog;
  let mockStripeGateway;
  let processor;
  let fixedNow = 1_700_000_000_000;
  const DAY_MS = 86400000;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        password_hash TEXT NOT NULL DEFAULT 'dummy',
        role TEXT NOT NULL DEFAULT 'free',
        max_connections INTEGER NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 0
      );
    `);

    process.env.CONNECTION_IDENTITY_HMAC_KEY = "test-hmac-secret-12345678901234567890";

    store = createBillingStore({
      db,
      now: () => fixedNow,
    });
    store.init();

    entitlementService = createEntitlementService({
      store,
      db,
      now: () => fixedNow,
    });

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
      createScheduleAfterPass: vi.fn().mockResolvedValue({ id: "sub_sched_123" }),
    };

    processor = createStripeEventProcessor({
      store,
      entitlementService,
      catalog,
      stripeGateway: mockStripeGateway,
      now: () => fixedNow,
    });
  });

  afterEach(() => {
    db?.close();
  });

  function createUser(username, role = "free") {
    const info = db.prepare("INSERT INTO users (username, role) VALUES (?, ?)").run(username, role);
    return { id: Number(info.lastInsertRowid), username, role };
  }

  describe("idempotent event claiming", () => {
    it("processes new event once and marks duplicate on replay", async () => {
      const user = createUser("user_event_claim", "free");
      const order = store.createOrder({
        id: "ord_claim_1",
        userId: user.id,
        productCode: "standard_pass_30d",
        amount: 399,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_claim_1",
      });

      const event = {
        id: "evt_123",
        type: "checkout.session.completed",
        created: 100,
        data: {
          object: {
            id: "cs_claim_1",
            mode: "payment",
            customer: "cus_123",
            payment_intent: "pi_123",
            metadata: { order_id: "ord_claim_1", user_id: String(user.id) },
          },
        },
      };

      const res1 = await processor.processEvent(event);
      expect(res1.duplicate).toBe(false);

      const savedOrder = store.getOrder("ord_claim_1");
      expect(savedOrder.status).toBe("paid");
      expect(entitlementService.getEffectiveAccess(user.id, fixedNow).role).toBe("regular");

      // Second attempt with same event ID
      const res2 = await processor.processEvent(event);
      expect(res2.duplicate).toBe(true);
    });
  });

  describe("checkout.session.completed", () => {
    it("handles 30-Day Pass payment mode and activates entitlement", async () => {
      const user = createUser("user_pass_checkout", "free");
      store.createOrder({
        id: "ord_pass_test",
        userId: user.id,
        productCode: "standard_pass_30d",
        amount: 399,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_pass_test",
      });

      const event = {
        id: "evt_pass_completed",
        type: "checkout.session.completed",
        created: 100,
        data: {
          object: {
            id: "cs_pass_test",
            mode: "payment",
            customer: "cus_pass_123",
            payment_intent: "pi_pass_123",
            metadata: { order_id: "ord_pass_test", user_id: String(user.id) },
          },
        },
      };

      await processor.processEvent(event);

      const order = store.getOrder("ord_pass_test");
      expect(order.status).toBe("paid");
      expect(order.stripe_customer_id).toBe("cus_pass_123");
      expect(order.stripe_payment_intent_id).toBe("pi_pass_123");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("regular");
      expect(access.plan).toBe("standard");
      expect(access.planSource).toBe("paid");
      expect(access.billingStatus).toBe("active");
    });

    it("handles subscription mode and activates recurring entitlement", async () => {
      const user = createUser("user_sub_checkout", "free");
      store.createOrder({
        id: "ord_sub_test",
        userId: user.id,
        productCode: "standard_monthly",
        amount: 299,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_sub_test",
      });

      const event = {
        id: "evt_sub_completed",
        type: "checkout.session.completed",
        created: 100,
        data: {
          object: {
            id: "cs_sub_test",
            mode: "subscription",
            customer: "cus_sub_123",
            subscription: "sub_stripe_123",
            metadata: { order_id: "ord_sub_test", user_id: String(user.id) },
          },
        },
      };

      await processor.processEvent(event);

      const order = store.getOrder("ord_sub_test");
      expect(order.status).toBe("paid");

      const sub = store.getSubscriptionByStripeId("sub_stripe_123");
      expect(sub).toBeDefined();
      expect(sub.status).toBe("active");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("regular");
      expect(access.plan).toBe("standard");
      expect(access.planSource).toBe("paid");
    });
  });

  describe("invoice events and payment failure grace", () => {
    it("handles invoice.payment_failed by starting grace period", async () => {
      const user = createUser("user_grace_test", "free");
      store.createOrder({
        id: "ord_sub_grace",
        userId: user.id,
        productCode: "standard_monthly",
        amount: 299,
        currency: "usd",
        status: "paid",
      });
      entitlementService.activateSubscription({
        userId: user.id,
        stripeSubscriptionId: "sub_grace_123",
        startsAt: fixedNow - 10 * DAY_MS,
        endsAt: fixedNow + 20 * DAY_MS,
      });

      const event = {
        id: "evt_inv_failed",
        type: "invoice.payment_failed",
        created: 200,
        data: {
          object: {
            subscription: "sub_grace_123",
            customer: "cus_grace_123",
          },
        },
      };

      await processor.processEvent(event);

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.billingStatus).toBe("grace");
      expect(access.role).toBe("regular");
    });
  });

  describe("charge.refunded", () => {
    it("handles charge.refunded by marking order refunded and revoking entitlement", async () => {
      const user = createUser("user_refund_test", "free");
      store.createOrder({
        id: "ord_ref_test",
        userId: user.id,
        productCode: "standard_pass_30d",
        amount: 399,
        currency: "usd",
        status: "paid",
        stripePaymentIntentId: "pi_refund_123",
      });
      entitlementService.activatePass({
        userId: user.id,
        orderId: "ord_ref_test",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      const event = {
        id: "evt_charge_refunded",
        type: "charge.refunded",
        created: 300,
        data: {
          object: {
            payment_intent: "pi_refund_123",
          },
        },
      };

      await processor.processEvent(event);

      const order = store.getOrder("ord_ref_test");
      expect(order.status).toBe("refunded");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("free");
    });
  });
});
