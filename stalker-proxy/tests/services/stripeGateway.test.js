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
    it("creates Subscription Schedule starting at pass end timestamp", async () => {
      const passEndSeconds = Math.floor((Date.now() + 30 * 86400000) / 1000);
      await gateway.createScheduleAfterPass({
        customerId: "cus_123",
        priceId: "price_monthly_123",
        startDate: passEndSeconds,
        orderId: "ord_sched_1",
      });

      expect(mockStripe.subscriptionSchedules.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_123",
          start_date: passEndSeconds,
          phases: [
            {
              items: [{ price: "price_monthly_123", quantity: 1 }],
            },
          ],
        }),
        expect.objectContaining({
          idempotencyKey: "schedule:ord_sched_1",
        })
      );
    });
  });
});
