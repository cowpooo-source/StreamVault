import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import express from "express";
import cookieParser from "cookie-parser";
import auth from "../../src/auth.js";
import { createBillingCatalog } from "../../src/services/billingCatalog.js";
import { createEntitlementService } from "../../src/services/entitlementService.js";
import { createConnectionAccessService } from "../../src/services/connectionAccessService.js";
import { createStripeGateway } from "../../src/services/stripeGateway.js";
import { createStripeEventProcessor } from "../../src/services/stripeEventProcessor.js";
import { createSupportService } from "../../src/services/supportService.js";
import { createReconciliationService } from "../../src/services/reconciliationService.js";
import { createBillingRouter } from "../../src/routes/billing.js";
import { createStripeWebhookRouter } from "../../src/routes/stripeWebhook.js";
import { createAccountConnectionsRouter } from "../../src/routes/accountConnections.js";
import { createSupportRouter } from "../../src/routes/support.js";

describe("Billing Lifecycle & Real Integration Suite", () => {
  let app;
  let db;
  let store;
  let catalog;
  let entitlementService;
  let connectionAccessService;
  let stripeGateway;
  let stripeProcessor;
  let supportService;
  let reconciliationService;
  let mockStripeSdk;
  let userToken;
  let testUser;
  let fixedNow = Date.now();

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");

    process.env.ADMIN_PASS = "admin123";
    process.env.ADMIN_USER = "admin";
    process.env.JWT_SECRET = "test-secret-key-123456";
    process.env.DEFAULT_ROLE = "free";
    process.env.CONNECTION_IDENTITY_HMAC_KEY = "test-hmac-secret-123456789012345678901234567890";

    await auth.init(db);
    store = auth.getBillingStore();
    entitlementService = auth.getEntitlementService();

    catalog = createBillingCatalog({
      BILLING_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_mock_secret",
      STRIPE_WEBHOOK_SECRET: "whsec_mock_webhook_secret",
      STRIPE_PRICE_STANDARD_PASS_30D: "price_standard_pass_30d",
      STRIPE_PRICE_STANDARD_MONTHLY: "price_standard_monthly",
      STRIPE_PRICE_STANDARD_YEARLY: "price_standard_yearly",
      STRIPE_LIVE_MODE: "false",
      STRIPE_TAX_ENABLED: "true",
      POLICY_TERMS_VERSION: "v1",
      POLICY_TERMS_URL: "https://media.portalheaven.stream/legal/terms-v1.html",
      POLICY_PRIVACY_VERSION: "v1",
      POLICY_PRIVACY_URL: "https://media.portalheaven.stream/legal/privacy-v1.html",
      POLICY_REFUND_VERSION: "v1",
      POLICY_REFUND_URL: "https://media.portalheaven.stream/legal/refund-v1.html",
      SUPPORT_EMAIL: "support@portalheaven.stream",
      SUPPORT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    });

    connectionAccessService = createConnectionAccessService({
      store,
      entitlementService,
      identityHmacKey: "test-hmac-secret-123456789012345678901234567890",
      now: () => fixedNow,
    });

    mockStripeSdk = {
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation(async (params) => ({
            id: "cs_mock_12345",
            url: "https://checkout.stripe.test/c/pay/cs_mock_12345",
            metadata: params.metadata,
          })),
        },
      },
      billingPortal: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            url: "https://billing.stripe.test/p/session_mock_12345",
          }),
        },
      },
      subscriptions: {
        update: vi.fn().mockResolvedValue({ id: "sub_mock_123", cancel_at_period_end: true }),
        retrieve: vi.fn().mockResolvedValue({ id: "sub_mock_123", status: "active" }),
      },
      subscriptionSchedules: {
        cancel: vi.fn().mockResolvedValue({ id: "sub_sched_mock_123", status: "canceled" }),
      },
      refunds: {
        create: vi.fn().mockResolvedValue({ id: "re_mock_123", status: "succeeded" }),
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({
          id: "pi_mock_123",
          status: "succeeded",
          amount: 399,
          amount_received: 399,
          currency: "usd",
          charges: { data: [{ id: "ch_mock_123", refunded: false, amount_refunded: 0 }] },
        }),
      },
      webhooks: {
        constructEvent: (rawBody, signature, secret) => {
          if (secret !== "whsec_mock_webhook_secret") throw new Error("Invalid secret");
          return JSON.parse(rawBody.toString("utf8"));
        },
      },
    };

    stripeGateway = createStripeGateway({
      stripe: mockStripeSdk,
      catalog,
      appUrl: "https://media.portalheaven.stream/app",
    });

    stripeProcessor = createStripeEventProcessor({
      store,
      entitlementService,
      catalog,
      stripeGateway,
      now: () => fixedNow,
    });

    supportService = createSupportService({
      store,
      catalog,
      mailService: { sendMail: vi.fn().mockResolvedValue({ messageId: "msg_123" }) },
      fetchFn: vi.fn().mockResolvedValue({ ok: true }),
      now: () => fixedNow,
    });

    reconciliationService = createReconciliationService({
      db,
      store,
      entitlementService,
      stripeGateway,
      connectionAccessService,
      supportService,
      now: () => fixedNow,
    });

    testUser = await auth.createUser("lifecycle_user", "password1234", "free");
    auth.updateUserEmail(testUser.id, "lifecycle@example.com");
    const session = await auth.authenticate("lifecycle_user", "password1234");
    userToken = session.token;

    app = express();
    // Raw webhook route BEFORE express.json()
    app.use(
      "/api/billing/webhook",
      createStripeWebhookRouter({
        stripe: mockStripeSdk,
        webhookSecret: "whsec_mock_webhook_secret",
        processor: stripeProcessor,
      })
    );

    app.use(express.json());
    app.use(cookieParser());

    app.use(
      "/api/billing",
      createBillingRouter({
        auth,
        catalog,
        store,
        stripeGateway,
        entitlementService,
      })
    );

    app.use(
      "/api/account/connections",
      createAccountConnectionsRouter({
        auth,
        connectionAccessService,
      })
    );

    app.use(
      "/api/support",
      createSupportRouter({
        auth,
        supportService,
      })
    );
  });

  afterEach(() => {
    db?.close();
  });

  it("completes full checkout lifecycle, stores published HTML agreement hashes, and activates entitlement via webhook", async () => {
    // 1. Initiate Checkout for 30-Day Pass
    const checkoutRes = await request(app)
      .post("/api/billing/checkout")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        productCode: "standard_pass_30d",
        acceptedPolicyVersions: {
          terms: "v1",
          privacy: "v1",
          refund: "v1",
        },
      });

    expect(checkoutRes.status).toBe(200);
    expect(checkoutRes.body).toHaveProperty("checkoutUrl");
    expect(checkoutRes.body).toHaveProperty("orderId");

    const orderId = checkoutRes.body.orderId;

    // Verify stored purchase agreement contains exact cryptographic SHA-256 of the published legal HTML documents
    const agreement = store.getAgreementByOrderId(orderId);
    expect(agreement).toBeDefined();
    expect(agreement.terms_sha256).toBe(catalog.getPolicyContentSha256("terms", "v1"));
    expect(agreement.privacy_sha256).toBe(catalog.getPolicyContentSha256("privacy", "v1"));
    expect(agreement.refund_sha256).toBe(catalog.getPolicyContentSha256("refund", "v1"));

    // 2. Deliver Webhook: checkout.session.completed
    const checkoutEvent = {
      id: "evt_checkout_success_1",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(fixedNow / 1000),
      data: {
        object: {
          id: "cs_mock_12345",
          mode: "payment",
          payment_intent: "pi_mock_123",
          customer: "cus_mock_123",
          client_reference_id: orderId,
          metadata: { orderId, userId: String(testUser.id), productCode: "standard_pass_30d" },
        },
      },
    };

    const webhookRes1 = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "valid_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(checkoutEvent));

    expect(webhookRes1.status).toBe(200);

    // Entitlement is now active!
    const effective = entitlementService.getEffectiveAccess(Number(testUser.id));
    expect(effective.role).toBe("regular");
    expect(effective.plan).toBe("standard");
    expect(effective.limits.maxConnections).toBe(5);

    // 3. Request Self-Service Refund within 7 calendar days
    const refundRes = await request(app)
      .post("/api/billing/refunds")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ orderId, reason: "Customer requested refund" });

    expect(refundRes.status).toBe(200);
    expect(refundRes.body.status).toBe("refund_pending");

    // 4. Deliver Webhook: charge.refunded
    const refundEvent = {
      id: "evt_refund_confirmed_1",
      type: "charge.refunded",
      livemode: false,
      created: Math.floor(fixedNow / 1000),
      data: {
        object: {
          id: "ch_mock_123",
          payment_intent: "pi_mock_123",
          customer: "cus_mock_123",
          refunded: true,
          amount_refunded: 399,
        },
      },
    };

    const webhookRes2 = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "valid_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(refundEvent));

    expect(webhookRes2.status).toBe(200);

    // Verify order is marked refunded and entitlement is revoked back to Free tier
    const updatedOrder = store.getOrder(orderId);
    expect(updatedOrder.status).toBe("refunded");
    expect(updatedOrder.refunded_at).not.toBeNull();

    const finalAccess = entitlementService.getEffectiveAccess(testUser.id);
    expect(finalAccess.role).toBe("free");
    expect(finalAccess.limits.maxConnections).toBe(2);

    // 5. Submit Support Ticket and process multi-channel outbox
    const ticketRes = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        category: "billing_refund",
        message: "Question regarding my completed refund confirmation.",
        orderId,
      });

    expect(ticketRes.status).toBe(201);
    expect(ticketRes.body.ticketId).toBeDefined();

    // Verify outbox queued notifications for user email, team alert email, and Discord webhook
    const due = store.getDueNotifications(Date.now() + 1000);
    expect(due.length).toBeGreaterThanOrEqual(3);

    // Run outbox worker sweep
    const outboxResult = await supportService.processOutbox();
    expect(outboxResult.sentCount).toBeGreaterThanOrEqual(3);
  });
});
