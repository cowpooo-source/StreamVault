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
      resolvePaymentMethodFromSetupIntent: vi.fn().mockResolvedValue("pm_setup_123"),
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
    it("handles invoice.payment_action_required by starting grace period", async () => {
      const user = createUser("user_action_req_test", "free");
      store.upsertSubscription({
        stripeSubscriptionId: "sub_action_req_123",
        userId: user.id,
        status: "active",
        lastStripeEventCreated: 100,
      });
      entitlementService.activateSubscription({
        userId: user.id,
        stripeSubscriptionId: "sub_action_req_123",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      const event = {
        id: "evt_action_req",
        type: "invoice.payment_action_required",
        created: 200,
        data: {
          object: {
            subscription: "sub_action_req_123",
            customer: "cus_action_req_123",
          },
        },
      };

      await processor.processEvent(event);

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.billingStatus).toBe("grace");
      expect(access.role).toBe("regular");
    });
  });

  describe("async checkout events", () => {
    it("handles checkout.session.async_payment_succeeded like checkout.session.completed", async () => {
      const user = createUser("user_async_success", "free");
      store.createOrder({
        id: "ord_async_succ",
        userId: user.id,
        productCode: "standard_pass_30d",
        amount: 399,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_async_succ",
      });

      const event = {
        id: "evt_async_succ",
        type: "checkout.session.async_payment_succeeded",
        created: 100,
        data: {
          object: {
            id: "cs_async_succ",
            mode: "payment",
            customer: "cus_async_succ",
            payment_intent: "pi_async_succ",
            metadata: { order_id: "ord_async_succ", user_id: String(user.id) },
          },
        },
      };

      const res = await processor.processEvent(event);
      expect(res.received).toBe(true);

      const order = store.getOrder("ord_async_succ");
      expect(order.status).toBe("paid");
      expect(entitlementService.getEffectiveAccess(user.id, fixedNow).role).toBe("regular");
    });

    it("handles checkout.session.async_payment_failed by updating order status", async () => {
      const user = createUser("user_async_fail", "free");
      store.createOrder({
        id: "ord_async_fail",
        userId: user.id,
        productCode: "standard_monthly",
        amount: 299,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_async_fail",
      });

      const event = {
        id: "evt_async_fail",
        type: "checkout.session.async_payment_failed",
        created: 100,
        data: {
          object: {
            id: "cs_async_fail",
            metadata: { order_id: "ord_async_fail", user_id: String(user.id) },
          },
        },
      };

      await processor.processEvent(event);
      const order = store.getOrder("ord_async_fail");
      expect(order.status).toBe("payment_failed");
    });

    it("handles checkout.session.expired by updating order status to expired", async () => {
      const user = createUser("user_expired_session", "free");
      store.createOrder({
        id: "ord_expired_test",
        userId: user.id,
        productCode: "standard_pass_30d",
        status: "pending",
        stripeCheckoutSessionId: "cs_expired_test",
      });

      const event = {
        id: "evt_cs_expired",
        type: "checkout.session.expired",
        created: 100,
        data: {
          object: {
            id: "cs_expired_test",
            metadata: { order_id: "ord_expired_test" },
          },
        },
      };

      await processor.processEvent(event);
      const order = store.getOrder("ord_expired_test");
      expect(order.status).toBe("expired");
    });
  });

  describe("subscription schedule lifecycle events", () => {
    it("handles subscription_schedule.created by linking schedule id to order", async () => {
      const user = createUser("user_sched_created", "free");
      const order = store.createOrder({
        id: "ord_sched_link",
        userId: user.id,
        productCode: "standard_monthly",
        status: "setup_completed",
      });

      const event = {
        id: "evt_sched_created",
        type: "subscription_schedule.created",
        created: 100,
        data: {
          object: {
            id: "sub_sched_linked_123",
            metadata: { order_id: order.id },
          },
        },
      };

      await processor.processEvent(event);
      const updatedOrder = store.getOrder(order.id);
      expect(updatedOrder.stripe_schedule_id).toBe("sub_sched_linked_123");
    });

    it("handles subscription_schedule.canceled by marking scheduled subscription canceled", async () => {
      const user = createUser("user_sched_cancel", "free");
      store.upsertSubscription({
        stripeSubscriptionId: "sched_sub_to_cancel",
        stripeScheduleId: "sub_sched_to_cancel",
        userId: user.id,
        status: "scheduled",
      });

      const event = {
        id: "evt_sched_canceled",
        type: "subscription_schedule.canceled",
        created: 100,
        data: {
          object: {
            id: "sub_sched_to_cancel",
          },
        },
      };

      await processor.processEvent(event);
      const sub = store.getSubscriptionByStripeId("sched_sub_to_cancel");
      expect(sub.status).toBe("canceled");
    });

    it("handles subscription_schedule.completed/released by activating the released subscription", async () => {
      const user = createUser("user_sched_release", "free");
      store.upsertSubscription({
        stripeSubscriptionId: "sched_placeholder_id",
        stripeScheduleId: "sub_sched_release_123",
        userId: user.id,
        status: "scheduled",
      });

      const event = {
        id: "evt_sched_released",
        type: "subscription_schedule.released",
        created: 200,
        data: {
          object: {
            id: "sub_sched_release_123",
            released_subscription: "sub_real_active_999",
          },
        },
      };

      await processor.processEvent(event);
      const sub = store.getSubscriptionByStripeId("sub_real_active_999");
      expect(sub.stripe_subscription_id).toBe("sub_real_active_999");
      expect(sub.status).toBe("active");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("regular");
      expect(access.billingStatus).toBe("active");
    });
  });

  describe("refund lifecycle and partial vs full refunds", () => {
    it("handles full charge.refunded by revoking entitlement and downgrading user to free", async () => {
      const user = createUser("user_full_refund", "free");
      store.createOrder({
        id: "ord_full_ref",
        userId: user.id,
        productCode: "standard_pass_30d",
        amountTotal: 399,
        currency: "usd",
        status: "paid",
        stripePaymentIntentId: "pi_full_ref_123",
      });
      entitlementService.activatePass({
        userId: user.id,
        orderId: "ord_full_ref",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      const event = {
        id: "evt_full_charge_refunded",
        type: "charge.refunded",
        created: 300,
        data: {
          object: {
            payment_intent: "pi_full_ref_123",
            amount: 399,
            amount_refunded: 399,
            refunded: true,
          },
        },
      };

      await processor.processEvent(event);

      const order = store.getOrder("ord_full_ref");
      expect(order.status).toBe("refunded");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("free");
    });

    it("partial charge.refunded must NOT revoke entitlement access", async () => {
      const user = createUser("user_partial_refund", "free");
      store.createOrder({
        id: "ord_part_ref",
        userId: user.id,
        productCode: "standard_pass_30d",
        amountTotal: 399,
        currency: "usd",
        status: "paid",
        stripePaymentIntentId: "pi_part_ref_123",
      });
      entitlementService.activatePass({
        userId: user.id,
        orderId: "ord_part_ref",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      // Partial refund of 100 cents out of 399 cents
      const event = {
        id: "evt_part_charge_refunded",
        type: "charge.refunded",
        created: 300,
        data: {
          object: {
            payment_intent: "pi_part_ref_123",
            amount: 399,
            amount_refunded: 100,
            refunded: false,
          },
        },
      };

      await processor.processEvent(event);

      const order = store.getOrder("ord_part_ref");
      // Status remains paid, amount updated, entitlement NOT revoked
      expect(order.status).toBe("paid");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("regular");
      expect(access.billingStatus).toBe("active");
    });

    it("handles refund.updated succeeded for partial refund without revoking access", async () => {
      const user = createUser("user_refund_evt_partial", "free");
      store.createOrder({
        id: "ord_refund_evt_partial",
        userId: user.id,
        productCode: "standard_pass_30d",
        amountTotal: 2999,
        currency: "usd",
        status: "paid",
        stripePaymentIntentId: "pi_refund_evt_part",
      });
      entitlementService.activatePass({
        userId: user.id,
        orderId: "ord_refund_evt_partial",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      const event = {
        id: "evt_refund_updated_part",
        type: "refund.updated",
        created: 300,
        data: {
          object: {
            payment_intent: "pi_refund_evt_part",
            amount: 500, // 500 < 2999 -> partial refund
            status: "succeeded",
          },
        },
      };

      await processor.processEvent(event);

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("regular");
      expect(access.billingStatus).toBe("active");
    });
  });

  describe("setup-mode and out-of-order protections and retries", () => {
    it("records setup-mode checkout as setup_completed and triggers future schedule", async () => {
      const user = createUser("user_setup_test", "free");
      store.createOrder({
        id: "ord_setup_test",
        userId: user.id,
        productCode: "standard_monthly",
        amount: 299,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_setup_test",
      });

      const event = {
        id: "evt_setup_test",
        type: "checkout.session.completed",
        created: 100,
        data: {
          object: {
            id: "cs_setup_test",
            mode: "setup",
            customer: "cus_setup_123",
            setup_intent: "seti_123",
            metadata: { order_id: "ord_setup_test", user_id: String(user.id) },
          },
        },
      };

      await processor.processEvent(event);

      const order = store.getOrder("ord_setup_test");
      expect(order.status).toBe("setup_completed");
      expect(mockStripeGateway.createScheduleAfterPass).toHaveBeenCalled();
    });

    it("retries previously failed event and succeeds on re-delivery", async () => {
      const user = createUser("user_retry_test", "free");
      const event = {
        id: "evt_retry_test",
        type: "checkout.session.completed",
        created: 100,
        data: {
          object: {
            id: "cs_retry_test",
            mode: "payment",
            customer: "cus_retry_123",
            payment_intent: "pi_retry_123",
            metadata: { order_id: "ord_nonexistent", user_id: String(user.id) },
          },
        },
      };

      // First run: simulate failure by mocking store method or throwing
      const originalActivate = entitlementService.activatePass;
      entitlementService.activatePass = vi.fn().mockImplementationOnce(() => {
        throw new Error("Temporary DB lock");
      });

      await expect(processor.processEvent(event)).rejects.toThrow("Temporary DB lock");

      const failedEventRecord = store.getEvent("evt_retry_test");
      expect(failedEventRecord.status).toBe("failed");
      expect(failedEventRecord.last_error_code).toBe("Temporary DB lock");

      // Restore and retry the same event
      entitlementService.activatePass = originalActivate;
      const res = await processor.processEvent(event);
      expect(res.duplicate).toBe(false);

      const processedEventRecord = store.getEvent("evt_retry_test");
      expect(processedEventRecord.status).toBe("processed");
    });

    it("ignores out-of-order stale invoice.payment_failed event when newer active event exists", async () => {
      const user = createUser("user_ooo_test", "free");
      store.upsertSubscription({
        stripeSubscriptionId: "sub_ooo_123",
        userId: user.id,
        status: "active",
        lastStripeEventCreated: 500, // Newer timestamp
      });
      entitlementService.activateSubscription({
        userId: user.id,
        stripeSubscriptionId: "sub_ooo_123",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      // Older stale event
      const staleEvent = {
        id: "evt_stale_failed",
        type: "invoice.payment_failed",
        created: 200, // Older than 500
        data: {
          object: {
            subscription: "sub_ooo_123",
          },
        },
      };

      await processor.processEvent(staleEvent);

      // Subscription should remain active, not moved to grace/past_due
      const sub = store.getSubscriptionByStripeId("sub_ooo_123");
      expect(sub.status).toBe("active");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.billingStatus).toBe("active");
    });

    it("rejects event when event livemode mismatches server configuration", async () => {
      // Server catalog is configured with livemode: false (STRIPE_LIVE_MODE="false")
      const liveEvent = {
        id: "evt_live_in_test_env",
        type: "invoice.paid",
        livemode: true, // Mismatches catalog.livemode (false)
        created: 100,
        data: {
          object: {
            subscription: "sub_live_123",
          },
        },
      };

      await expect(processor.processEvent(liveEvent)).rejects.toThrow(/Livemode mismatch/);
    });
  });

  describe("Subscription Schedule Start Activation and Resolution Fail-safes", () => {
    it("activates scheduled subscription at start date via customer.subscription.created, replaces placeholder id, and activates entitlement", async () => {
      const user = createUser("user_sched_start", "free");
      const order = store.createOrder({
        id: "ord_sched_start_1",
        userId: user.id,
        productCode: "standard_monthly",
        amount: 299,
        currency: "usd",
        status: "setup_completed",
        stripeScheduleId: "sub_sched_777",
      });

      // Insert scheduled subscription with placeholder ID
      store.upsertSubscription({
        stripeSubscriptionId: "sched_sub_sub_sched_777",
        stripeScheduleId: "sub_sched_777",
        userId: user.id,
        productCode: "standard_monthly",
        status: "scheduled",
        scheduledStartAt: fixedNow + 30 * DAY_MS,
      });

      // At start date, Stripe creates real subscription sub_real_999 linked to schedule sub_sched_777
      const event = {
        id: "evt_sub_created_schedule_start",
        type: "customer.subscription.created",
        created: 200,
        data: {
          object: {
            id: "sub_real_999",
            schedule: "sub_sched_777",
            status: "active",
            current_period_start: Math.floor(fixedNow / 1000),
            current_period_end: Math.floor((fixedNow + 30 * DAY_MS) / 1000),
            metadata: {
              order_id: "ord_sched_start_1",
              user_id: String(user.id),
            },
          },
        },
      };

      const res = await processor.processEvent(event);
      expect(res.duplicate).toBe(false);

      // Verify placeholder was replaced with real Stripe ID and status is active
      const activeSub = store.getSubscriptionByStripeId("sub_real_999");
      expect(activeSub).toBeDefined();
      expect(activeSub.status).toBe("active");
      expect(activeSub.stripe_schedule_id).toBe("sub_sched_777");

      // Verify entitlement was activated
      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("regular");
      expect(access.plan).toBe("standard");
      expect(access.billingStatus).toBe("active");
      expect(access.limits.maxConnections).toBe(5);

      // Verify invoice.paid can reconcile this activated subscription
      const invoiceEvent = {
        id: "evt_inv_paid_reconcile",
        type: "invoice.paid",
        created: 210,
        data: {
          object: {
            subscription: "sub_real_999",
            lines: {
              data: [
                {
                  period: {
                    end: Math.floor((fixedNow + 60 * DAY_MS) / 1000),
                  },
                },
              ],
            },
          },
        },
      };

      await processor.processEvent(invoiceEvent);
      const renewedSub = store.getSubscriptionByStripeId("sub_real_999");
      expect(renewedSub.current_period_end).toBe(fixedNow + 60 * DAY_MS);
    });

    it("activates subscription schedule on completion using schedule.subscription when released_subscription is absent", async () => {
      const user = createUser("user_sched_comp", "free");
      store.upsertSubscription({
        stripeSubscriptionId: "sched_sub_sub_sched_comp",
        stripeScheduleId: "sub_sched_comp",
        userId: user.id,
        productCode: "standard_yearly",
        status: "scheduled",
      });

      const event = {
        id: "evt_sched_completed_no_rel",
        type: "subscription_schedule.completed",
        created: 300,
        data: {
          object: {
            id: "sub_sched_comp",
            subscription: "sub_yearly_real_555", // actual subscription field
          },
        },
      };

      await processor.processEvent(event);

      const activeSub = store.getSubscriptionByStripeId("sub_yearly_real_555");
      expect(activeSub).toBeDefined();
      expect(activeSub.status).toBe("active");

      const access = entitlementService.getEffectiveAccess(user.id, fixedNow);
      expect(access.role).toBe("regular");
    });

    it("fails retryably when checkout.session.completed has no order and no effective user", async () => {
      const event = {
        id: "evt_unresolvable_checkout",
        type: "checkout.session.completed",
        created: 100,
        data: {
          object: {
            id: "cs_orphan_123",
            mode: "payment",
            metadata: {}, // No order_id, no user_id
          },
        },
      };

      await expect(processor.processEvent(event)).rejects.toThrow(/Unresolvable user/);

      const eventRecord = store.getEvent("evt_unresolvable_checkout");
      expect(eventRecord.status).toBe("failed");
      expect(eventRecord.last_error_code).toMatch(/Unresolvable user/);
    });

    it("fails retryably when invoice.paid cannot resolve a subscription", async () => {
      const event = {
        id: "evt_orphan_invoice_paid",
        type: "invoice.paid",
        created: 100,
        data: {
          object: {
            subscription: "sub_ghost_123",
          },
        },
      };

      await expect(processor.processEvent(event)).rejects.toThrow(/Subscription not found/);

      const eventRecord = store.getEvent("evt_orphan_invoice_paid");
      expect(eventRecord.status).toBe("failed");
      expect(eventRecord.last_error_code).toMatch(/Subscription not found/);
    });

    it("fails retryably when subscription_schedule.completed cannot resolve the schedule", async () => {
      const event = {
        id: "evt_orphan_schedule_comp",
        type: "subscription_schedule.completed",
        created: 100,
        data: {
          object: {
            id: "sub_sched_ghost_999",
            subscription: "sub_ghost_sub",
          },
        },
      };

      await expect(processor.processEvent(event)).rejects.toThrow(/Subscription schedule not found/);

      const eventRecord = store.getEvent("evt_orphan_schedule_comp");
      expect(eventRecord.status).toBe("failed");
    });

    it("safely ignores unhandled event types without error", async () => {
      const event = {
        id: "evt_ignored_test",
        type: "customer.created",
        created: 100,
        data: {
          object: {
            id: "cus_ignored_1",
          },
        },
      };

      const res = await processor.processEvent(event);
      expect(res.received).toBe(true);
      expect(res.ignored).toBe(true);
      expect(res.duplicate).toBe(false);

      const eventRecord = store.getEvent("evt_ignored_test");
      expect(eventRecord.status).toBe("ignored");
    });
  });
});
