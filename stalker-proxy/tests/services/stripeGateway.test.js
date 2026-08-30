import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStripeGateway } from "../../src/services/stripeGateway.js";
import { createBillingCatalog } from "../../src/services/billingCatalog.js";

describe("stripeGateway", () => {
  let mockStripe;
  let catalog;
  let gateway;
  const appUrl = "https://media.portalheaven.stream/app";

  beforeEach(() => {
    mockStripe = {
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" }),
        },
      },
      billingPortal: {
        sessions: {
          create: vi.fn().mockResolvedValue({ id: "bps_123", url: "https://billing.stripe.com/p/session/bps_123" }),
        },
      },
      subscriptions: {
        update: vi.fn().mockResolvedValue({ id: "sub_123", cancel_at_period_end: true }),
        retrieve: vi.fn().mockResolvedValue({ id: "sub_123", status: "active" }),
      },
      subscriptionSchedules: {
        create: vi.fn().mockResolvedValue({ id: "sub_sched_123", status: "not_started" }),
        cancel: vi.fn().mockResolvedValue({ id: "sub_sched_123", status: "canceled" }),
        retrieve: vi.fn().mockResolvedValue({ id: "sub_sched_123", status: "active" }),
      },
      refunds: {
        create: vi.fn().mockResolvedValue({ id: "re_123", status: "succeeded" }),
      },
      customers: {
        create: vi.fn().mockResolvedValue({ id: "cus_123" }),
        retrieve: vi.fn().mockResolvedValue({ id: "cus_123" }),
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "pi_123", status: "succeeded" }),
      },
      setupIntents: {
        retrieve: vi.fn().mockResolvedValue({ id: "seti_123", payment_method: "pm_resolved_456" }),
      },
    };

    catalog = createBillingCatalog({
      BILLING_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_STANDARD_PASS_30D: "price_pass_123",
      STRIPE_PRICE_STANDARD_MONTHLY: "price_monthly_123",
      STRIPE_PRICE_STANDARD_YEARLY: "price_yearly_123",
      STRIPE_LIVE_MODE: "false",
      STRIPE_TAX_ENABLED: "true",
      POLICY_TERMS_VERSION: "v1",
      POLICY_TERMS_URL: "https://media.portalheaven.stream/legal/terms-v1.html",
      POLICY_PRIVACY_VERSION: "v1",
      POLICY_PRIVACY_URL: "https://media.portalheaven.stream/legal/privacy-v1.html",
      POLICY_REFUND_VERSION: "v1",
      POLICY_REFUND_URL: "https://media.portalheaven.stream/legal/refund-v1.html",
      APP_URL: appUrl,
    });

    gateway = createStripeGateway({
      stripe: mockStripe,
      catalog,
      appUrl,
    });
  });

  describe("createCheckout", () => {
    it("creates payment Checkout Session for 30-Day Pass with required parameters", async () => {
      const order = {
        id: "ord_pass_1",
        userId: 42,
        productCode: "standard_pass_30d",
        priceId: "price_pass_123",
      };

      const res = await gateway.createCheckout({
        order,
        customerId: "cus_123",
        returnPath: "/app?settingsTab=billing",
      });

      expect(res).toMatchObject({
        sessionId: "cs_test_123",
        checkoutUrl: "https://checkout.stripe.com/pay/cs_test_123",
      });

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          mode: "payment",
          billing_address_collection: "required",
          automatic_tax: { enabled: true },
          consent_collection: { terms_of_service: "required" },
          line_items: [{ price: "price_pass_123", quantity: 1 }],
          metadata: { order_id: "ord_pass_1", user_id: "42" },
        }),
        expect.objectContaining({
          idempotencyKey: "checkout:ord_pass_1",
        })
      );
    });

    it("creates subscription Checkout Session for monthly Standard", async () => {
      const order = {
        id: "ord_sub_1",
        userId: 7,
        productCode: "standard_monthly",
        priceId: "price_monthly_123",
      };

      await gateway.createCheckout({
        order,
        customerId: "cus_123",
      });

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          mode: "subscription",
          line_items: [{ price: "price_monthly_123", quantity: 1 }],
          metadata: { order_id: "ord_sub_1", user_id: "7" },
        }),
        expect.objectContaining({
          idempotencyKey: "checkout:ord_sub_1",
        })
      );
    });
  });

  describe("createSetupCheckout", () => {
    it("creates Setup Checkout Session for pass-to-subscription future transition", async () => {
      const order = {
        id: "ord_setup_1",
        userId: 15,
        productCode: "standard_monthly",
      };

      await gateway.createSetupCheckout({
        order,
        customerId: "cus_123",
      });

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          mode: "setup",
          setup_intent_data: {
            metadata: { order_id: "ord_setup_1", user_id: "15" },
          },
        }),
        expect.objectContaining({
          idempotencyKey: "setup:ord_setup_1",
        })
      );
    });
  });

  describe("Customer Portal and Cancellations", () => {
    it("creates short-lived billing portal session", async () => {
      const res = await gateway.createPortalSession({ customerId: "cus_123" });
      expect(res.url).toBe("https://billing.stripe.com/p/session/bps_123");
      expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: "cus_123",
        return_url: appUrl,
      });
    });

    it("schedules cancellation at period end with idempotency key", async () => {
      await gateway.cancelAtPeriodEnd({ subscriptionId: "sub_123" });
      expect(mockStripe.subscriptions.update).toHaveBeenCalledWith(
        "sub_123",
        { cancel_at_period_end: true },
        { idempotencyKey: "cancel:sub_123" }
      );
    });

    it("cancels future subscription schedule with idempotency key", async () => {
      await gateway.cancelSchedule({ scheduleId: "sub_sched_123" });
      expect(mockStripe.subscriptionSchedules.cancel).toHaveBeenCalledWith(
        "sub_sched_123",
        {},
        { idempotencyKey: "cancel_schedule:sub_sched_123" }
      );
    });

    it("retrieves a subscription for reconciliation", async () => {
      const result = await gateway.retrieveSubscription("sub_123");

      expect(result).toEqual({ id: "sub_123", status: "active" });
      expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_123");
    });
  });

  describe("Automatic Refunds", () => {
    it("creates full refund for payment intent with idempotency key", async () => {
      const res = await gateway.createFullRefund({
        paymentIntentId: "pi_123",
        orderId: "ord_ref_1",
      });
      expect(res.status).toBe("succeeded");
      expect(mockStripe.refunds.create).toHaveBeenCalledWith(
        {
          payment_intent: "pi_123",
          metadata: { order_id: "ord_ref_1" },
        },
        {
          idempotencyKey: "refund:ord_ref_1",
        }
      );
    });
  });

  describe("Subscription Schedule after Pass", () => {
    it("creates Subscription Schedule with end_behavior: release and monthly duration for monthly product", async () => {
      const passEndSeconds = Math.floor((Date.now() + 30 * 86400000) / 1000);
      await gateway.createScheduleAfterPass({
        customerId: "cus_123",
        priceId: "price_monthly_123",
        startDate: passEndSeconds,
        orderId: "ord_sched_1",
        userId: 42,
        productCode: "standard_monthly",
      });

      expect(mockStripe.subscriptionSchedules.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          start_date: passEndSeconds,
          end_behavior: "release",
          metadata: {
            order_id: "ord_sched_1",
            user_id: "42",
            product_code: "standard_monthly",
          },
          phases: [
            expect.objectContaining({
              items: [{ price: "price_monthly_123", quantity: 1 }],
              duration: {
                interval: "month",
                interval_count: 1,
              },
              metadata: {
                order_id: "ord_sched_1",
                user_id: "42",
                product_code: "standard_monthly",
              },
            }),
          ],
        }),
        expect.objectContaining({
          idempotencyKey: "schedule:ord_sched_1",
        })
      );
    });

    it("creates Subscription Schedule with end_behavior: release and yearly duration for yearly product", async () => {
      const passEndSeconds = Math.floor((Date.now() + 30 * 86400000) / 1000);
      await gateway.createScheduleAfterPass({
        customerId: "cus_456",
        priceId: "price_yearly_456",
        startDate: passEndSeconds,
        orderId: "ord_sched_yearly",
        userId: 99,
        productCode: "standard_yearly",
      });

      expect(mockStripe.subscriptionSchedules.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_456",
          start_date: passEndSeconds,
          end_behavior: "release",
          metadata: {
            order_id: "ord_sched_yearly",
            user_id: "99",
            product_code: "standard_yearly",
          },
          phases: [
            expect.objectContaining({
              items: [{ price: "price_yearly_456", quantity: 1 }],
              duration: {
                interval: "year",
                interval_count: 1,
              },
              metadata: {
                order_id: "ord_sched_yearly",
                user_id: "99",
                product_code: "standard_yearly",
              },
            }),
          ],
        }),
        expect.objectContaining({
          idempotencyKey: "schedule:ord_sched_yearly",
        })
      );
    });

    it("resolves setup_intent to payment_method before schedule creation", async () => {
      const passEndSeconds = Math.floor((Date.now() + 30 * 86400000) / 1000);
      await gateway.createScheduleAfterPass({
        customerId: "cus_123",
        priceId: "price_monthly_123",
        startDate: passEndSeconds,
        orderId: "ord_sched_seti",
        setupIntentId: "seti_123",
      });

      expect(mockStripe.setupIntents.retrieve).toHaveBeenCalledWith("seti_123");
      expect(mockStripe.subscriptionSchedules.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          end_behavior: "release",
          default_settings: {
            default_payment_method: "pm_resolved_456",
          },
        }),
        expect.objectContaining({
          idempotencyKey: "schedule:ord_sched_seti",
        })
      );
    });

    it("resolves payment method from various setup intent formats", async () => {
      expect(await gateway.resolvePaymentMethodFromSetupIntent("pm_already_pm")).toBe("pm_already_pm");
      expect(await gateway.resolvePaymentMethodFromSetupIntent({ payment_method: "pm_obj_1" })).toBe("pm_obj_1");
      expect(await gateway.resolvePaymentMethodFromSetupIntent({ payment_method: { id: "pm_obj_2" } })).toBe("pm_obj_2");

      const resolved = await gateway.resolvePaymentMethodFromSetupIntent("seti_123");
      expect(resolved).toBe("pm_resolved_456");
    });
  });
});
