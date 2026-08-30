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
  let mockFetch;
  let supportService;
  let fixedNow = 1_700_000_000_000;

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
      SUPPORT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/xyz",
    });

    mockMailService = {
      sendMail: vi.fn().mockResolvedValue({ messageId: "msg_123" }),
    };

    mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    supportService = createSupportService({
      store,
      catalog,
      mailService: mockMailService,
      fetchFn: mockFetch,
      now: () => fixedNow,
    });
  });

  afterEach(() => {
    db?.close();
  });

  describe("createTicket", () => {
    it("creates support ticket and enqueues user email, team email, and discord alert in outbox", async () => {
      const ticket = await supportService.createTicket({
        userId: 42,
        userEmail: "user42@example.com",
        category: "billing_refund",
        message: "I need help with my subscription receipt.",
        orderId: "ord_123",
      });

      expect(ticket).toBeDefined();
      expect(ticket.id).toMatch(/^tkt_/);
      expect(ticket.user_id).toBe(42);
      expect(ticket.category).toBe("billing_refund");
      expect(ticket.status).toBe("open");

      // Verify notifications in outbox: user email, support-team email, discord alert
      const due = store.getDueNotifications(fixedNow + 1000);
      expect(due.length).toBe(3);

      const userNotif = due.find((n) => n.template === "ticket_received");
      expect(userNotif).toBeDefined();
      expect(userNotif.recipient).toBe("user42@example.com");

      const teamNotif = due.find((n) => n.template === "support_team_ticket_alert");
      expect(teamNotif).toBeDefined();
      expect(teamNotif.recipient).toBe("support@portalheaven.stream");

      const discordNotif = due.find((n) => n.template === "ticket_discord_alert");
      expect(discordNotif).toBeDefined();
      expect(discordNotif.recipient).toBe("https://discord.com/api/webhooks/123/xyz");
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

    it("rejects messages shorter than 10 characters or longer than 2000", async () => {
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "technical",
          message: "Too short",
        })
      ).rejects.toThrow(/message length/i);

      // Exactly 2000 characters is allowed
      const exact2000 = "a".repeat(2000);
      const ticket2000 = await supportService.createTicket({
        userId: 42,
        category: "technical",
        message: exact2000,
      });
      expect(ticket2000).toBeDefined();

      // 2001 characters is rejected
      const longMessage = "a".repeat(2001);
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "technical",
          message: longMessage,
        })
      ).rejects.toMatchObject({ code: "invalid_message_length" });
    });

    it("rejects credit card numbers before persistence or outbox queuing", async () => {
      const initialTickets = store.listTicketsForUser(42).length;
      const initialOutbox = store.getDueNotifications(fixedNow + 10000).length;

      await expect(
        supportService.createTicket({
          userId: 42,
          category: "Billing/Refund",
          message: "Please help, my card 4111 1111 1111 1111 was charged twice.",
        })
      ).rejects.toMatchObject({ code: "support_sensitive_content" });

      // Ensure no ticket or notification was persisted
      expect(store.listTicketsForUser(42).length).toBe(initialTickets);
      expect(store.getDueNotifications(fixedNow + 10000).length).toBe(initialOutbox);
    });

    it("rejects URLs with embedded credentials", async () => {
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "technical",
          message: "Cannot connect to stream at http://user:superpass123@stream.provider.tv:8080/live",
        })
      ).rejects.toMatchObject({ code: "support_sensitive_content" });
    });

    it("rejects password and credential phrases", async () => {
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "account",
          message: "I forgot my password: MySecretPass1234 please reset it",
        })
      ).rejects.toMatchObject({ code: "support_sensitive_content" });

      await expect(
        supportService.createTicket({
          userId: 42,
          category: "account",
          message: "Here is my api_key: sk_test_secret_api_key_12345",
        })
      ).rejects.toMatchObject({ code: "support_sensitive_content" });
    });

    it("rejects content-token / JWT-like strings", async () => {
      const jwtSample = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      await expect(
        supportService.createTicket({
          userId: 42,
          category: "technical",
          message: `Here is the token error: ${jwtSample}`,
        })
      ).rejects.toMatchObject({ code: "support_sensitive_content" });

      await expect(
        supportService.createTicket({
          userId: 42,
          category: "technical",
          message: "My content token was ctok_0123456789abcdef0123456789abcdef",
        })
      ).rejects.toMatchObject({ code: "support_sensitive_content" });
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
        category: "technical",
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
    it("sends queued notifications via mailService and Discord webhook and marks them sent", async () => {
      await supportService.createTicket({
        userId: 42,
        userEmail: "user42@example.com",
        category: "billing_refund",
        message: "I need help with my invoice.",
      });

      const result = await supportService.processOutbox({ batchSize: 10 });
      expect(result.sentCount).toBe(3);
      expect(result.failedCount).toBe(0);

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user42@example.com",
          subject: expect.stringContaining("Support Ticket"),
        })
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/123/xyz",
        expect.objectContaining({
          method: "POST",
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
        category: "billing_refund",
        message: "Need help with invoice please.",
      });

      const result = await supportService.processOutbox({ batchSize: 10 });
      expect(result.failedCount).toBeGreaterThanOrEqual(1);

      // Notification is in backoff: not due immediately
      const immediateDue = store.getDueNotifications(fixedNow);
      expect(immediateDue.length).toBe(0);

      // Due after backoff delay
      const laterDue = store.getDueNotifications(fixedNow + 10 * 60 * 1000);
      expect(laterDue.length).toBeGreaterThanOrEqual(1);
    });

    it("delivers billing notifications through sendEmail with safe HTML content", async () => {
      const sendEmail = vi.fn().mockResolvedValue(true);
      const billingMailService = createSupportService({
        store,
        catalog,
        mailService: { sendEmail },
        fetchFn: mockFetch,
        now: () => fixedNow,
      });

      store.enqueueNotification({
        id: "notif_billing_email",
        channel: "email",
        template: "billing_subscription_created",
        recipient: "billing@example.com",
        payloadJson: JSON.stringify({
          userId: 42,
          productCode: "standard_monthly",
          subscriptionId: "sub_123",
          accessEndsAt: fixedNow + 30 * 86400000,
        }),
        status: "queued",
        nextAttemptAt: fixedNow,
      });

      const result = await billingMailService.processOutbox({ batchSize: 1 });

      expect(result).toEqual({ sentCount: 1, failedCount: 0 });
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: "billing@example.com",
        subject: "Your Portal Heaven subscription is active",
        html: expect.stringContaining("Subscription created"),
      }));
    });

    it("reclaims processing notifications if a worker crashed and lock expired", async () => {
      await supportService.createTicket({
        userId: 100,
        userEmail: "crash_user@example.com",
        category: "technical",
        message: "Video playback issue on screen.",
      });

      // Claim notifications (sets status = 'processing', next_attempt_at = fixedNow + 300000)
      const claimed = store.claimDueNotifications(fixedNow, 10, 300000);
      expect(claimed.length).toBe(3);

      // Immediately after claiming, no more due notifications
      expect(store.getDueNotifications(fixedNow).length).toBe(0);

      // After lock expires at fixedNow + 300001, processing rows become due again
      const expiredDue = store.getDueNotifications(fixedNow + 300001);
      expect(expiredDue.length).toBe(3);
      expect(expiredDue[0].status).toBe("processing");
    });
  });
});
