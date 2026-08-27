import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { createBillingStore } from "../../src/services/billingStore.js";

describe("billingStore", () => {
  let db;
  let store;
  let fixedNow = 1_700_000_000_000;
  const identityKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    db = new Database(":memory:");
    store = createBillingStore({
      db,
      now: () => fixedNow,
      identityHmacKey: identityKey,
    });
    store.init();
  });

  afterEach(() => {
    db?.close();
  });

  describe("schema initialization and idempotency", () => {
    it("initializes tables and indexes idempotently", () => {
      expect(() => store.init()).not.toThrow();
      expect(() => store.init()).not.toThrow();
    });

    it("creates all required additive tables in SQLite", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);

      expect(tables).toContain("billing_customers");
      expect(tables).toContain("billing_orders");
      expect(tables).toContain("billing_subscriptions");
      expect(tables).toContain("billing_entitlements");
      expect(tables).toContain("billing_events");
      expect(tables).toContain("policy_versions");
      expect(tables).toContain("purchase_agreements");
      expect(tables).toContain("connection_access");
      expect(tables).toContain("support_tickets");
      expect(tables).toContain("notification_outbox");
    });
  });

  describe("orders and purchase agreements", () => {
    it("creates and retrieves an order with USD currency and cents", () => {
      const order = store.createOrder({
        id: "ord_test_1",
        userId: 42,
        productCode: "standard_pass_30d",
        checkoutMode: "payment",
        priceId: "price_pass_123",
        amountSubtotal: 399,
        amountTax: 0,
        amountTotal: 399,
      });

      expect(order.id).toBe("ord_test_1");
      expect(order.user_id).toBe(42);
      expect(order.currency).toBe("usd");
      expect(order.amount_total).toBe(399);
      expect(order.status).toBe("created");

      const fetched = store.getOrder("ord_test_1");
      expect(fetched).toMatchObject({
        id: "ord_test_1",
        user_id: 42,
        product_code: "standard_pass_30d",
        checkout_mode: "payment",
        currency: "usd",
        amount_total: 399,
        status: "created",
      });
    });

    it("atomically creates order and agreement inside a single transaction", () => {
      const orderData = {
        id: "ord_tx_1",
        userId: 10,
        productCode: "standard_monthly",
        checkoutMode: "subscription",
        priceId: "price_monthly_123",
        amountTotal: 299,
      };

      const agreementData = {
        id: "agr_tx_1",
        orderId: "ord_tx_1",
        userId: 10,
        termsVersion: "v1",
        privacyVersion: "v1",
        refundVersion: "v1",
        termsSha256: "hash_terms",
        privacySha256: "hash_privacy",
        refundSha256: "hash_refund",
        acceptedAt: fixedNow,
      };

      store.createOrderWithAgreement({ order: orderData, agreement: agreementData });

      expect(store.getOrder("ord_tx_1")).toBeDefined();
      expect(store.getAgreementByOrderId("ord_tx_1")).toMatchObject({
        id: "agr_tx_1",
        terms_version: "v1",
        terms_sha256: "hash_terms",
      });
    });

    it("rolls back order creation if agreement insertion fails", () => {
      const orderData = {
        id: "ord_fail_1",
        userId: 10,
        productCode: "standard_monthly",
        checkoutMode: "subscription",
        priceId: "price_monthly_123",
      };

      // Invalid agreement with null orderId to trigger constraint violation
      const invalidAgreement = {
        id: null,
        orderId: null,
      };

      expect(() =>
        store.createOrderWithAgreement({ order: orderData, agreement: invalidAgreement })
      ).toThrow();

      expect(store.getOrder("ord_fail_1")).toBeUndefined();
    });
  });

  describe("events idempotency and payload redaction", () => {
    it("claims event once and returns false on duplicate", () => {
      const payloadSha = crypto.createHash("sha256").update("payload").digest("hex");
      const firstClaim = store.claimEvent({
        stripeEventId: "evt_dup_1",
        eventType: "invoice.paid",
        livemode: 0,
        stripeCreatedAt: 1700000000,
        payloadSha256: payloadSha,
      });
      expect(firstClaim.claimed).toBe(true);

      const duplicateClaim = store.claimEvent({
        stripeEventId: "evt_dup_1",
        eventType: "invoice.paid",
        livemode: 0,
        stripeCreatedAt: 1700000000,
        payloadSha256: payloadSha,
      });
      expect(duplicateClaim.claimed).toBe(false);

      // When event fails, first retry atomically claims it; second concurrent retry is rejected
      store.updateEventStatus("evt_dup_1", "failed", { lastErrorCode: "timeout" });

      const firstRetry = store.claimEvent({
        stripeEventId: "evt_dup_1",
        eventType: "invoice.paid",
        livemode: 0,
        stripeCreatedAt: 1700000000,
        payloadSha256: payloadSha,
      });
      expect(firstRetry.claimed).toBe(true);
      expect(firstRetry.status).toBe("retried");

      const concurrentRetry = store.claimEvent({
        stripeEventId: "evt_dup_1",
        eventType: "invoice.paid",
        livemode: 0,
        stripeCreatedAt: 1700000000,
        payloadSha256: payloadSha,
      });
      expect(concurrentRetry.claimed).toBe(false);
      expect(concurrentRetry.status).toBe("processing");
    });

    it("verifies billing_events contains no unredacted payload column", () => {
      const cols = db
        .prepare("PRAGMA table_info(billing_events)")
        .all()
        .map((c) => c.name);

      expect(cols).toContain("payload_sha256");
      expect(cols).not.toContain("payload");
      expect(cols).not.toContain("raw_payload");
      expect(cols).not.toContain("payload_json");
    });
  });

  describe("customer mapping and subscriptions", () => {
    it("upserts customer mapping and retrieves by user or stripe customer id", () => {
      store.upsertCustomer({ userId: 7, stripeCustomerId: "cus_xyz789" });

      expect(store.getCustomerByUserId(7)).toMatchObject({
        user_id: 7,
        stripe_customer_id: "cus_xyz789",
      });
      expect(store.getUserByStripeCustomerId("cus_xyz789")).toMatchObject({
        user_id: 7,
        stripe_customer_id: "cus_xyz789",
      });
    });

    it("creates and updates subscriptions projection", () => {
      store.upsertSubscription({
        id: "sub_local_1",
        userId: 7,
        productCode: "standard_monthly",
        stripeSubscriptionId: "sub_stripe_1",
        status: "active",
        currentPeriodStart: fixedNow,
        currentPeriodEnd: fixedNow + 30 * 86400000,
        cancelAtPeriodEnd: 0,
        lastStripeEventCreated: 100,
      });

      const sub = store.getSubscriptionByStripeId("sub_stripe_1");
      expect(sub.status).toBe("active");
      expect(sub.cancel_at_period_end).toBe(0);

      store.updateSubscriptionStatus("sub_stripe_1", {
        status: "active",
        cancelAtPeriodEnd: 1,
        lastStripeEventCreated: 200,
      });

      const updated = store.getSubscriptionByStripeId("sub_stripe_1");
      expect(updated.cancel_at_period_end).toBe(1);
      expect(updated.last_stripe_event_created).toBe(200);
    });
  });

  describe("entitlements ledger", () => {
    it("creates and retrieves entitlements for user", () => {
      store.createEntitlement({
        id: "ent_1",
        userId: 7,
        tier: "standard",
        sourceType: "pass",
        sourceId: "ord_test_1",
        status: "active",
        startsAt: fixedNow,
        endsAt: fixedNow + 30 * 86400000,
      });

      const list = store.listEntitlementsForUser(7);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: "ent_1",
        user_id: 7,
        tier: "standard",
        source_type: "pass",
        status: "active",
      });
    });

    it("enforces unique constraint on sourceType and sourceId", () => {
      store.createEntitlement({
        id: "ent_a",
        userId: 7,
        tier: "standard",
        sourceType: "pass",
        sourceId: "ord_unique_1",
        status: "active",
        startsAt: fixedNow,
        endsAt: fixedNow + 86400000,
      });

      expect(() =>
        store.createEntitlement({
          id: "ent_b",
          userId: 7,
          tier: "standard",
          sourceType: "pass",
          sourceId: "ord_unique_1",
          status: "active",
          startsAt: fixedNow,
          endsAt: fixedNow + 86400000,
        })
      ).toThrow();
    });
  });

  describe("connection access hashing", () => {
    it("hashes raw connection IDs with HMAC-SHA256 before saving", () => {
      const rawId = "stalker_portal_http://iptv.example.com/c/00:1A:79:00:11:22";
      store.recordConnectionUse(7, rawId, fixedNow);

      const records = store.listConnectionAccessForUser(7);
      expect(records).toHaveLength(1);

      const expectedKey = crypto
        .createHmac("sha256", identityKey)
        .update(rawId)
        .digest("hex");

      expect(records[0].connection_key).toBe(expectedKey);
      expect(records[0].connection_key).not.toContain("00:1A:79:00:11:22");
    });

    it("fails closed when no HMAC secret is configured or derivable", () => {
      const oldEnvKey = process.env.CONNECTION_IDENTITY_HMAC_KEY;
      const oldMasterKey = process.env.TOKEN_MASTER_KEY;
      const oldJwt = process.env.JWT_SECRET;
      delete process.env.CONNECTION_IDENTITY_HMAC_KEY;
      delete process.env.TOKEN_MASTER_KEY;
      delete process.env.JWT_SECRET;

      try {
        expect(() =>
          createBillingStore({
            db,
            identityHmacKey: "",
          })
        ).toThrow(/required to derive connection HMAC identity/);
      } finally {
        if (oldEnvKey) process.env.CONNECTION_IDENTITY_HMAC_KEY = oldEnvKey;
        if (oldMasterKey) process.env.TOKEN_MASTER_KEY = oldMasterKey;
        if (oldJwt) process.env.JWT_SECRET = oldJwt;
      }
    });

    it("atomically swaps locked and active connections with swapConnectionSelection", () => {
      store.recordConnectionUse(42, "conn_active", fixedNow);
      store.updateConnectionLock(42, "conn_locked", { lockedAt: fixedNow });

      const res = store.swapConnectionSelection(42, "conn_locked", "conn_active", fixedNow + 100);
      expect(res.ok).toBe(true);

      const activeRecord = store.getConnectionAccess(42, "conn_locked");
      expect(activeRecord.locked_at).toBeNull();
      expect(activeRecord.selected_at).toBe(fixedNow + 100);

      const lockedRecord = store.getConnectionAccess(42, "conn_active");
      expect(lockedRecord.locked_at).toBe(fixedNow + 100);
      expect(lockedRecord.selected_at).toBeNull();
    });
  });

  describe("support tickets and notification outbox", () => {
    it("atomically creates support ticket and enqueues notifications", () => {
      const ticket = {
        id: "tkt_abc123",
        userId: 7,
        category: "billing_refund",
        message: "Need assistance with billing charge",
        status: "open",
      };

      const notifications = [
        {
          id: "notif_email_1",
          channel: "email",
          template: "support_ticket_confirmation",
          recipient: "user@example.com",
          payloadJson: JSON.stringify({ ticketId: "tkt_abc123" }),
        },
        {
          id: "notif_discord_1",
          channel: "discord",
          template: "support_ticket_alert",
          recipient: null,
          payloadJson: JSON.stringify({ ticketId: "tkt_abc123", category: "billing_refund" }),
        },
      ];

      store.createTicketWithNotifications({ ticket, notifications });

      const savedTicket = store.getTicket("tkt_abc123");
      expect(savedTicket).toMatchObject({
        id: "tkt_abc123",
        category: "billing_refund",
      });

      const due = store.getDueNotifications(fixedNow + 1000);
      expect(due).toHaveLength(2);
      expect(due.map((d) => d.id)).toContain("notif_email_1");
      expect(due.map((d) => d.id)).toContain("notif_discord_1");
    });
  });
});
