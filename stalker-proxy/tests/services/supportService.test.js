import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createBillingStore } from "../../src/services/billingStore.js";
import { createBillingCatalog } from "../../src/services/billingCatalog.js";
import { createSupportService } from "../../src/services/supportService.js";

describe("supportService", () => {
  let db;
  let store;
  let catalog;
  let mockMailService;
  let supportService;
  let fixedNow = 1_700_000_000_000;
  const HOUR_MS = 3600000;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createBillingStore({ db, now: () => fixedNow });
    store.init();

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
  });

  afterEach(() => {
    db?.close();
  });

  describe("createTicket", () => {
    it("creates support ticket and enqueues notification in outbox transactionally", async () => {
      const ticket = await supportService.createTicket({
        userId: 42,
        userEmail: "user42@example.com",
        category: "billing",
        message: "I need help with my subscription receipt.",
        orderId: "ord_123",
      });

      expect(ticket).toBeDefined();
      expect(ticket.id).toMatch(/^tkt_/);
      expect(ticket.user_id).toBe(42);
      expect(ticket.category).toBe("billing");
      expect(ticket.status).toBe("open");

      // Verify notification in outbox
      const due = store.getDueNotifications(fixedNow + 1000);
      expect(due.length).toBe(1);
      expect(due[0].recipient).toBe("user42@example.com");
      expect(due[0].template).toBe("ticket_received");
      expect(due[0].status).toBe("queued");
    });

    it("rejects invalid categories", async () => {
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "invalid_category",
          message: "Valid message length here for testing.",
        })
      ).rejects.toThrow(/category/i);
    });

    it("rejects messages shorter than 10 characters or longer than 4000", async () => {
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "playback",
          message: "Too short",
        })
      ).rejects.toThrow(/message length/i);

      const longMessage = "a".repeat(4001);
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "playback",
          message: longMessage,
        })
      ).rejects.toThrow(/message length/i);
    });

    it("enforces rate limit of 5 tickets per user per 24 hours", async () => {
      for (let i = 1; i <= 5; i++) {
        await supportService.createTicket({
          userId: 99,
          category: "other",
          message: `Ticket number ${i} with valid content length.`,
        });
      }

      // 6th ticket should fail
      await expect(
        supportService.createTicket({
          userId: 99,
          category: "other",
          message: "6th ticket within 24 hours.",
        })
      ).rejects.toThrow(/rate limit/i);
    });
  });

  describe("listTickets and getTicket", () => {
    it("lists tickets belonging to user and retrieves specific ticket", async () => {
      const t1 = await supportService.createTicket({
        userId: 10,
        category: "playback",
        message: "Playback issue on channel 5.",
      });

      const list = supportService.listTickets(10);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(t1.id);

      const retrieved = supportService.getTicket(10, t1.id);
      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe(t1.id);

      // Other user cannot retrieve ticket
      expect(supportService.getTicket(999, t1.id)).toBeNull();
    });
  });

  describe("processOutbox", () => {
    it("sends queued notifications via mailService and marks them sent", async () => {
      await supportService.createTicket({
        userId: 42,
        userEmail: "user42@example.com",
        category: "billing",
        message: "I need help with my invoice.",
      });

      const result = await supportService.processOutbox({ batchSize: 10 });
      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(0);

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user42@example.com",
          subject: expect.stringContaining("Support Ticket"),
        })
      );

      // Verify no more due notifications
      const remaining = store.getDueNotifications(fixedNow + 1000);
      expect(remaining.length).toBe(0);
    });

    it("applies exponential backoff on mail failure", async () => {
      mockMailService.sendMail = vi.fn().mockRejectedValue(new Error("SMTP server down"));

      await supportService.createTicket({
        userId: 42,
        userEmail: "fail_user@example.com",
        category: "billing",
        message: "Need help with invoice please.",
      });

      const result = await supportService.processOutbox({ batchSize: 10 });
      expect(result.sentCount).toBe(0);
      expect(result.failedCount).toBe(1);

      // Notification is in backoff: not due immediately
      const immediateDue = store.getDueNotifications(fixedNow);
      expect(immediateDue.length).toBe(0);

      // Due after backoff delay (e.g. 5 minutes)
      const laterDue = store.getDueNotifications(fixedNow + 10 * 60 * 1000);
      expect(laterDue.length).toBe(1);
      expect(laterDue[0].attempt_count).toBe(1);
    });
  });
});
