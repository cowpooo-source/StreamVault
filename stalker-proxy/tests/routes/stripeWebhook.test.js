import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3";
import { createBillingStore } from "../../src/services/billingStore.js";
import { createEntitlementService } from "../../src/services/entitlementService.js";
import { createBillingCatalog } from "../../src/services/billingCatalog.js";
import { createStripeEventProcessor } from "../../src/services/stripeEventProcessor.js";
import { createStripeWebhookRouter } from "../../src/routes/stripeWebhook.js";

describe("Stripe Webhook Router", () => {
  let app;
  let db;
  let store;
  let processor;
  let mockStripe;
  const webhookSecret = "whsec_test_secret";

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

    store = createBillingStore({ db });
    store.init();

    const entitlementService = createEntitlementService({ store, db });

    const catalog = createBillingCatalog({
      BILLING_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
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

    processor = createStripeEventProcessor({
      store,
      entitlementService,
      catalog,
      stripeGateway: {},
    });

    mockStripe = {
      webhooks: {
        constructEvent: vi.fn(),
      },
    };

    app = express();
    // Raw body parsing mounted specifically on webhook path
    app.use(
      "/api/billing/webhook",
      createStripeWebhookRouter({
        stripe: mockStripe,
        processor,
        webhookSecret,
      })
    );
    app.use(express.json());
  });

  afterEach(() => {
    db?.close();
  });

  it("rejects request when stripe signature verification fails", async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "bad_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ id: "evt_fail" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid signature/);
  });

  it("processes event and returns 200 on valid signature", async () => {
    const event = {
      id: "evt_success_1",
      type: "invoice.payment_failed",
      created: 100,
      data: {
        object: {
          subscription: "sub_none",
        },
      },
    };

    mockStripe.webhooks.constructEvent.mockReturnValue(event);

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "valid_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(event));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true });
  });

  it("fails closed with 500 when stripe client or webhookSecret is missing", async () => {
    const unconfiguredApp = express();
    unconfiguredApp.use(
      "/api/billing/webhook",
      createStripeWebhookRouter({
        stripe: null,
        processor,
        webhookSecret: null,
      })
    );

    const res = await request(unconfiguredApp)
      .post("/api/billing/webhook")
      .set("stripe-signature", "some_sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ id: "evt_bypass_attempt" }));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/not configured/);
  });
});
