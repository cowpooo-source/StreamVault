import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createBillingStore } from "../../src/services/billingStore.js";
import { createEntitlementService } from "../../src/services/entitlementService.js";
import { createConnectionAccessService } from "../../src/services/connectionAccessService.js";
import { createReconciliationService } from "../../src/services/reconciliationService.js";

describe("reconciliationService", () => {
  let db;
  let store;
  let entitlementService;
  let connectionAccessService;
  let reconciliationService;
  let mockStripeGateway;
  let fixedNow = 1_700_000_000_000;
  const DAY_MS = 86400000;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'free',
        max_connections INTEGER NOT NULL DEFAULT 2
      );
    `);

    store = createBillingStore({
      db,
      identityHmacKey: "test-hmac-secret-key-1234567890",
      now: () => fixedNow,
    });
    store.init();

    entitlementService = createEntitlementService({
      store,
      db,
      gracePeriodHours: 72,
      now: () => fixedNow,
    });

    connectionAccessService = createConnectionAccessService({
      store,
      entitlementService,
      identityHmacKey: "test-hmac-secret-key-1234567890",
      now: () => fixedNow,
    });

    mockStripeGateway = {
      retrieveSubscription: vi.fn(),
    };

    reconciliationService = createReconciliationService({
      db,
      store,
      entitlementService,
      stripeGateway: mockStripeGateway,
      connectionAccessService,
      now: () => fixedNow,
    });
  });

  afterEach(() => {
    db?.close();
  });

  describe("reconcileExpiredGrants", () => {
    it("expires passes and friend_family grants past their ends_at timestamp and demotes user", async () => {
      db.prepare("INSERT INTO users (id, username, role, max_connections) VALUES (1, 'user1', 'free', 2)").run();

      // Pass expired 1 day ago
      store.createEntitlement({
        id: "ent_expired_pass",
        userId: 1,
        tier: "standard",
        sourceType: "pass",
        sourceId: "ord_expired_1",
        status: "active",
        startsAt: fixedNow - 31 * DAY_MS,
        endsAt: fixedNow - 1 * DAY_MS,
      });

      const result = await reconciliationService.reconcileExpiredGrants();
      expect(result.expiredCount).toBe(1);
      expect(result.demotedUserIds).toContain(1);

      // Entitlement status updated to expired
      const ent = store.getEntitlement("ent_expired_pass");
      expect(ent.status).toBe("expired");

      // User role demoted to free
      const user = db.prepare("SELECT role, max_connections FROM users WHERE id = 1").get();
      expect(user.role).toBe("free");
      expect(user.max_connections).toBe(2);
    });

    it("reconciles connection locks on demoted users", async () => {
      db.prepare("INSERT INTO users (id, username, role, max_connections) VALUES (2, 'user2', 'free', 2)").run();

      // User had 3 connections registered
      store.recordConnectionUse(2, "portal:conn1");
      store.recordConnectionUse(2, "portal:conn2");
      store.recordConnectionUse(2, "portal:conn3");

      // Expired grant
      store.createEntitlement({
        id: "ent_expired_2",
        userId: 2,
        tier: "standard",
        sourceType: "pass",
        sourceId: "ord_expired_2",
        status: "active",
        startsAt: fixedNow - 31 * DAY_MS,
        endsAt: fixedNow - 1 * DAY_MS,
      });

      await reconciliationService.reconcileExpiredGrants();

      // User 2 is now free (limit 2 connections) -> conn3 must be locked
      const access = store.listConnectionAccessForUser(2);
      const locked = access.filter((c) => c.locked_at !== null);
      const active = access.filter((c) => c.locked_at === null);
      expect(active.length).toBe(2);
      expect(locked.length).toBe(1);
    });
  });

  describe("reconcileStripeSubscriptions", () => {
    it("detects drift between local subscription and Stripe status and updates entitlement", async () => {
      db.prepare("INSERT INTO users (id, username, role, max_connections) VALUES (3, 'user3', 'regular', 5)").run();

      store.upsertSubscription({
        userId: 3,
        productCode: "standard_monthly",
        stripeSubscriptionId: "sub_drift_1",
        status: "active",
        currentPeriodStart: fixedNow - 30 * DAY_MS,
        currentPeriodEnd: fixedNow + 30 * DAY_MS,
      });

      store.createEntitlement({
        id: "ent_drift_1",
        userId: 3,
        tier: "standard",
        sourceType: "subscription",
        sourceId: "sub_drift_1",
        status: "active",
        startsAt: fixedNow - 30 * DAY_MS,
        endsAt: fixedNow + 30 * DAY_MS,
      });

      // Stripe says subscription was canceled
      mockStripeGateway.retrieveSubscription.mockResolvedValue({
        id: "sub_drift_1",
        status: "canceled",
        current_period_end: Math.floor((fixedNow - 1 * DAY_MS) / 1000),
      });

      const result = await reconciliationService.reconcileStripeSubscriptions();
      expect(result.resolvedDriftCount).toBe(1);

      const updatedSub = store.getSubscriptionByStripeId("sub_drift_1");
      expect(updatedSub.status).toBe("canceled");

      const ent = store.getEntitlement("ent_drift_1");
      expect(ent.status).toBe("expired");
    });
  });

  describe("runFullReconciliation", () => {
    it("runs full sweep and records audit log", async () => {
      const summary = await reconciliationService.runFullReconciliation();
      expect(summary).toHaveProperty("expiredGrants");
      expect(summary).toHaveProperty("resolvedDrifts");

      const auditRows = store.listAuditLogs ? store.listAuditLogs() : [];
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
