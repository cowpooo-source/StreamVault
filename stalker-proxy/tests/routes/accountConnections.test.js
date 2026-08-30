import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import auth from "../../src/auth.js";
import { createConnectionAccessService } from "../../src/services/connectionAccessService.js";
import { createAccountConnectionsRouter } from "../../src/routes/accountConnections.js";

describe("Account Connections Router", () => {
  let app;
  let db;
  let connectionAccessService;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");

    process.env.ADMIN_PASS = "admin123";
    process.env.ADMIN_USER = "admin";
    process.env.JWT_SECRET = "test-secret-key";
    process.env.DEFAULT_ROLE = "free";

    await auth.init(db);

    const store = auth.getBillingStore();
    const entitlementService = auth.getEntitlementService();

    connectionAccessService = createConnectionAccessService({
      store,
      entitlementService,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/account/connections", createAccountConnectionsRouter({ auth, connectionAccessService }));
  });

  afterEach(() => {
    db?.close();
  });

  it("requires authentication for /reconcile and /select", async () => {
    const res = await request(app).post("/api/account/connections/reconcile").send({ connectionIds: ["a", "b"] });
    expect(res.status).toBe(401);

    const res2 = await request(app).post("/api/account/connections/select").send({ selectConnectionId: "a", deselectConnectionId: "b" });
    expect(res2.status).toBe(401);
  });

  it("rejects cross-origin or missing origin headers for cookie-authenticated requests with 403 csrf_rejected", async () => {
    const user = await auth.createUser("csrf_conn_user", "pass1234", "free");
    const session = await auth.authenticate(user.username, "pass1234");

    // Missing origin/referer with cookie authentication
    const resMissing = await request(app)
      .post("/api/account/connections/reconcile")
      .set("Cookie", `sv_auth=${session.token}`)
      .send({ connectionIds: ["c1"] });
    expect(resMissing.status).toBe(403);
    expect(resMissing.body.code).toBe("csrf_rejected");

    // Cross-origin with cookie authentication
    const resCross = await request(app)
      .post("/api/account/connections/reconcile")
      .set("Cookie", `sv_auth=${session.token}`)
      .set("Origin", "https://malicious-attacker.com")
      .send({ connectionIds: ["c1"] });
    expect(resCross.status).toBe(403);
    expect(resCross.body.code).toBe("csrf_rejected");

    // Cross-origin select with cookie authentication
    const resSelectCross = await request(app)
      .post("/api/account/connections/select")
      .set("Cookie", `sv_auth=${session.token}`)
      .set("Origin", "https://malicious-attacker.com")
      .send({ selectConnectionId: "c1", deselectConnectionId: "c2" });
    expect(resSelectCross.status).toBe(403);
    expect(resSelectCross.body.code).toBe("csrf_rejected");
  });

  it("accepts same-origin cookie requests for /reconcile and /select", async () => {
    const user = await auth.createUser("same_origin_user", "pass1234", "free");
    const session = await auth.authenticate(user.username, "pass1234");

    const res = await request(app)
      .post("/api/account/connections/reconcile")
      .set("Cookie", `sv_auth=${session.token}`)
      .set("Host", "media.portalheaven.stream")
      .set("Origin", "https://media.portalheaven.stream")
      .send({ connectionIds: ["c1", "c2"] });

    expect(res.status).toBe(200);
    expect(res.body.maxActive).toBe(2);
  });

  it("reconciles connections for authenticated user with Bearer token", async () => {
    const user = await auth.createUser("conn_user", "pass1234", "free");
    const session = await auth.authenticate(user.username, "pass1234");

    const res = await request(app)
      .post("/api/account/connections/reconcile")
      .set("Authorization", `Bearer ${session.token}`)
      .send({
        connectionIds: ["c1", "c2", "c3"],
        clientOrder: ["c1", "c2", "c3"],
      });

    expect(res.status).toBe(200);
    expect(res.body.maxActive).toBe(2);
    expect(res.body.connections).toHaveLength(3);
    expect(res.body.connections.filter((c) => c.status === "active")).toHaveLength(2);
    expect(res.body.connections.filter((c) => c.status === "locked_by_plan_limit")).toHaveLength(1);
  });
});
