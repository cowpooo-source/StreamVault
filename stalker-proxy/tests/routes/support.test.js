import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import auth from "../../src/auth.js";
import { createBillingCatalog } from "../../src/services/billingCatalog.js";
import { createSupportService } from "../../src/services/supportService.js";
import { createSupportRouter } from "../../src/routes/support.js";

describe("Support Routes", () => {
  let app;
  let db;
  let store;
  let catalog;
  let supportService;
  let mockMailService;
  let userToken;
  let testUser;
  let fixedNow = 1_700_000_000_000;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");

    process.env.ADMIN_PASS = "admin123";
    process.env.ADMIN_USER = "admin";
    process.env.JWT_SECRET = "test-secret-key";
    process.env.DEFAULT_ROLE = "free";
    process.env.CONNECTION_IDENTITY_HMAC_KEY = "test-hmac-secret-12345678901234567890";

    await auth.init(db);
    store = auth.getBillingStore();

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
      SUPPORT_EMAIL: "support@portalheaven.stream",
    });

    mockMailService = {
      sendMail: vi.fn().mockResolvedValue({ messageId: "msg_123" }),
    };

    supportService = createSupportService({
      store,
      catalog,
      mailService: mockMailService,
      now: () => fixedNow,
    });

    testUser = await auth.createUser("sup_user", "pass1234", "free");
    auth.updateUserEmail(testUser.id, "sup_user@example.com");
    const session = await auth.authenticate(testUser.username, "pass1234");
    userToken = session.token;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
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

  it("requires authentication for all support routes", async () => {
    const resList = await request(app).get("/api/support/tickets");
    expect(resList.status).toBe(401);

    const resCreate = await request(app)
      .post("/api/support/tickets")
      .send({ category: "billing_refund", message: "Help needed on billing." });
    expect(resCreate.status).toBe(401);
  });

  it("creates a support ticket via POST /api/support/tickets", async () => {
    const res = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        category: "billing_refund",
        message: "I need help with my payment invoice.",
        orderId: "ord_123",
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("ticketId");
    expect(res.body.status).toBe("open");
    expect(res.body.category).toBe("billing_refund");

    // List tickets
    const listRes = await request(app)
      .get("/api/support/tickets")
      .set("Authorization", `Bearer ${userToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.tickets.length).toBe(1);
    expect(listRes.body.tickets[0].id).toBe(res.body.ticketId);

    // Get ticket by ID
    const getRes = await request(app)
      .get(`/api/support/tickets/${res.body.ticketId}`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.ticket.id).toBe(res.body.ticketId);
    expect(getRes.body.ticket.message).toBe("I need help with my payment invoice.");
  });

  it("validates message length and category", async () => {
    const resShort = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ category: "billing_refund", message: "Too short" });

    expect(resShort.status).toBe(400);

    const resBadCategory = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ category: "unknown_cat", message: "Valid message length here." });

    expect(resBadCategory.status).toBe(400);
  });

  it("returns 404 when requesting nonexistent ticket or another user's ticket", async () => {
    const res = await request(app)
      .get("/api/support/tickets/tkt_nonexistent")
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(404);
  });
});
