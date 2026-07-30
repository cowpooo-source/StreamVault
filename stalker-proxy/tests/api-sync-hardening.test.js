import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createApiRouter } from "../src/routes/api.js";

function makeHarness() {
  const rows = [{ conn_id: "conn-1", type: "favorites", data: JSON.stringify({ live: {} }) }];
  const statement = { all: vi.fn().mockReturnValue(rows) };
  const cache = {
    saveGuestData: vi.fn(),
    getGuestData: vi.fn().mockReturnValue(null),
    deleteGuestData: vi.fn(),
    db: { prepare: vi.fn().mockReturnValue(statement) },
  };
  const auth = {
    optionalAuth: (req, _res, next) => {
      req.user = req.headers.authorization ? { id: 7 } : null;
      next();
    },
    requireAuth: (req, _res, next) => {
      req.user = { id: 7 };
      next();
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter({ cache, auth }));
  return { app, cache };
}

describe("connection sync hardening", () => {
  let harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("rejects an unconfirmed encrypted empty connection snapshot", async () => {
    const encryptedEmpty = `${"A".repeat(16)}.${"B".repeat(24)}`;
    const response = await request(harness.app)
      .put("/api/sync/connections")
      .set("Authorization", "Bearer test")
      .send({ connId: "_all", data: encryptedEmpty, count: 0 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("empty_connections_rejected");
    expect(harness.cache.saveGuestData).not.toHaveBeenCalled();
  });

  it("allows deleting the final connection only with explicit confirmation", async () => {
    const response = await request(harness.app)
      .put("/api/sync/connections")
      .set("Authorization", "Bearer test")
      .send({
        connId: "_all",
        data: "[]",
        count: 0,
        allowEmpty: true,
        reason: "user_removed_last_connection",
      });

    expect(response.status).toBe(200);
    expect(harness.cache.saveGuestData).toHaveBeenCalledWith("user:7", "_all", "connections", "[]");
  });

  it("does not copy guest connection ciphertext during account migration", async () => {
    const response = await request(harness.app)
      .post("/api/sync/migrate-guest")
      .set("X-Guest-Id", "guest-123")
      .send({ guestId: "guest-123" });

    expect(response.status).toBe(200);
    expect(harness.cache.db.prepare).toHaveBeenCalledWith(expect.stringContaining("type != 'connections'"));
    expect(harness.cache.saveGuestData).toHaveBeenCalledWith("user:7", "conn-1", "favorites", { live: {} });
  });
});
