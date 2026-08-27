import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createBillingStore } from "../../src/services/billingStore.js";
import { createEntitlementService } from "../../src/services/entitlementService.js";
import { createConnectionAccessService } from "../../src/services/connectionAccessService.js";

describe("connectionAccessService", () => {
  let db;
  let store;
  let entitlementService;
  let connectionService;
  let fixedNow = 1_700_000_000_000;
  const identityKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

    store = createBillingStore({
      db,
      now: () => fixedNow,
      identityHmacKey: identityKey,
    });
    store.init();

    entitlementService = createEntitlementService({
      store,
      db,
      now: () => fixedNow,
    });

    connectionService = createConnectionAccessService({
      store,
      entitlementService,
      identityHmacKey: identityKey,
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

  describe("reconcileConnections and downgrade limits", () => {
    it("locks overflow connections beyond maxConnections ranked by last_used_at and clientOrder", () => {
      const user = createUser("user_down", "free"); // limit = 2
      const connA = "conn_a";
      const connB = "conn_b";
      const connC = "conn_c";

      // connB used most recently, connC used before that, connA never used
      store.recordConnectionUse(user.id, connC, fixedNow - 10000);
      store.recordConnectionUse(user.id, connB, fixedNow - 5000);

      const result = connectionService.reconcileConnections({
        userId: user.id,
        connectionIds: [connA, connB, connC],
        clientOrder: [connC, connB, connA],
      });

      expect(result.maxActive).toBe(2);
      expect(result.connections).toHaveLength(3);

      const statusMap = Object.fromEntries(result.connections.map((c) => [c.connectionId, c.status]));
      expect(statusMap[connB]).toBe("active");
      expect(statusMap[connC]).toBe("active");
      expect(statusMap[connA]).toBe("locked_by_plan_limit");
    });

    it("throws connection_plan_locked when accessing locked connection", () => {
      const user = createUser("user_locked", "free");
      const connA = "conn_a";
      const connB = "conn_b";
      const connC = "conn_c";

      store.recordConnectionUse(user.id, connC, fixedNow - 1000);
      store.recordConnectionUse(user.id, connB, fixedNow - 500);

      connectionService.reconcileConnections({
        userId: user.id,
        connectionIds: [connA, connB, connC],
      });

      expect(() => connectionService.assertConnectionAllowed(user.id, connA)).toThrow(/locked/);
      try {
        connectionService.assertConnectionAllowed(user.id, connA);
      } catch (err) {
        expect(err.code).toBe("connection_plan_locked");
        expect(err.status).toBe(403);
      }

      expect(() => connectionService.assertConnectionAllowed(user.id, connB)).not.toThrow();
    });

    it("allows all connections for Standard / Regular tier (limit = 5)", () => {
      const user = createUser("user_std", "regular");
      const conns = ["c1", "c2", "c3", "c4", "c5"];

      const result = connectionService.reconcileConnections({
        userId: user.id,
        connectionIds: conns,
      });

      expect(result.maxActive).toBe(5);
      expect(result.connections.every((c) => c.status === "active")).toBe(true);
      for (const c of conns) {
        expect(() => connectionService.assertConnectionAllowed(user.id, c)).not.toThrow();
      }
    });

    it("swaps active and locked connections using selectConnection", () => {
      const user = createUser("user_swap", "free");
      const connA = "conn_a";
      const connB = "conn_b";
      const connC = "conn_c";

      store.recordConnectionUse(user.id, connB, fixedNow - 1000);
      store.recordConnectionUse(user.id, connC, fixedNow - 2000);

      connectionService.reconcileConnections({
        userId: user.id,
        connectionIds: [connA, connB, connC],
      });

      // Swap locked connA in place of active connC
      connectionService.selectConnection({
        userId: user.id,
        selectConnectionId: connA,
        deselectConnectionId: connC,
      });

      expect(() => connectionService.assertConnectionAllowed(user.id, connA)).not.toThrow();
      expect(() => connectionService.assertConnectionAllowed(user.id, connC)).toThrow();
    });

    it("blocks new unrecorded 3rd connection when Free user already has 2 active connections", () => {
      const user = createUser("user_overflow", "free");
      const conn1 = "conn_1";
      const conn2 = "conn_2";
      const conn3 = "conn_3";

      // User has 2 active connections recorded
      store.recordConnectionUse(user.id, conn1, fixedNow - 1000);
      store.recordConnectionUse(user.id, conn2, fixedNow - 500);

      // Existing 2 active connections are allowed
      expect(() => connectionService.assertConnectionAllowed(user.id, conn1)).not.toThrow();
      expect(() => connectionService.assertConnectionAllowed(user.id, conn2)).not.toThrow();

      // Brand new 3rd connection without upgrade is blocked
      expect(() => connectionService.assertConnectionAllowed(user.id, conn3)).toThrow(/limit/);
      try {
        connectionService.assertConnectionAllowed(user.id, conn3);
      } catch (err) {
        expect(err.code).toBe("connection_plan_locked");
        expect(err.status).toBe(403);
      }
    });

    it("rejects selectConnection when selecting an unsaved connection", () => {
      const user = createUser("user_unsaved", "free");
      const connA = "conn_a";
      const connB = "conn_b";

      store.recordConnectionUse(user.id, connA, fixedNow - 1000);

      expect(() =>
        connectionService.selectConnection({
          userId: user.id,
          selectConnectionId: "unsaved_conn",
          deselectConnectionId: connA,
        })
      ).toThrow(/Cannot select unsaved connection/);
    });
  });
});
